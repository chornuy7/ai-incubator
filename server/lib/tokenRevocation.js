/**
 * Гашение старых токенов при выходе (MR-203, вторая половина).
 *
 * ЧТО БЫЛО. Токен сессии — stateless HMAC со сроком в неделю (`session.js`), а серверный
 * выход закрывал только смену рабочего времени и писал аудит. Отзыва не было ни в каком
 * виде: `verifySession` смотрела на подпись и срок, и всё. Значит любая копия строки
 * токена — застрявшая в хранилище браузера, попавшая в бэкап профиля, снятая с чужого
 * экрана — оставалась рабочим ключом к аккаунту ещё до семи суток ПОСЛЕ выхода. Чистка
 * localStorage закрывала это только в том браузере, где нажали «Выйти».
 *
 * ЧТО СТАЛО. У профиля есть отметка `tokens_valid_from`. Выход ставит в неё «сейчас», и
 * любой токен, выданный РАНЬШЕ этого момента, перестаёт приниматься. Человек выходит —
 * все его прежние токены умирают разом, на всех устройствах.
 *
 * ПОЧЕМУ НЕ ТАБЛИЦА СЕССИЙ. Она означала бы запись в БД на каждый вход и чтение на каждый
 * запрос. Здесь один столбец и одна карта в памяти: токен остаётся stateless, а отзыв
 * стоит ровно одну отметку времени.
 *
 * ПОЧЕМУ КЕШ. Проверять отзыв походом в БД на каждый запрос к /api — это лишний round-trip
 * на всё подряд. Держим карту «кто когда вышел» в памяти и обновляем её раз в полминуты;
 * выход в ЭТОМ же процессе кладёт отметку сразу, поэтому свои токены гаснут мгновенно.
 * Отставание возможно только между разными процессами и ограничено `REFRESH_MS`.
 */
import { getSupabase, supabaseEnabled } from './supabase.js'

/** Как часто перечитываем отметки из БД. Полминуты: выходы редки, запросы часты. */
export const REFRESH_MS = 30 * 1000

/** userId → миллисекунда, раньше которой токены этого человека не принимаются. */
/**
 * Молчащая поломка здесь опаснее самой дыры: без колонки `tokens_valid_from` отзыв просто
 * не работает, а выглядит как работающий. Поэтому о сбое говорим вслух — но один раз на
 * причину, чтобы не залить лог одинаковыми строками на каждый запрос.
 */
const warned = new Set()
function warnOnce(что, error) {
  const key = `${что}:${error?.code || error?.message || ''}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[отзыв токенов] ${что} не удалось: ${error?.message || error}. Применена ли миграция 2026-08-29-token-revocation.sql?`)
}

let cache = new Map()
let loadedAt = 0
let loading = null

/** Файловый режим (дев/тесты): БД нет, отметки живут только в памяти процесса. */
const memoryOnly = () => !supabaseEnabled()

async function reload() {
  if (memoryOnly()) { loadedAt = Date.now(); return }
  const db = getSupabase()
  // Берём только тех, кто хоть раз выходил: у остальных отметки нет, и карта не пухнет.
  const { data, error } = await db.from('profiles').select('legacy_id, tokens_valid_from').not('tokens_valid_from', 'is', null)
  if (error) { warnOnce('чтение отметок выхода', error); return }
  const next = new Map()
  for (const r of data || []) {
    if (!r.legacy_id) continue
    const ms = new Date(r.tokens_valid_from).getTime()
    if (Number.isFinite(ms)) next.set(r.legacy_id, ms)
  }
  // Отметки, поставленные этим процессом, не теряем: запрос мог уйти до нашей записи.
  for (const [uid, ms] of cache) if (!(next.get(uid) >= ms)) next.set(uid, ms)
  cache = next
  loadedAt = Date.now()
}

/**
 * Дождаться, что карта отзывов загружена. Ждём по-настоящему только первый раз; дальше
 * возвращаемся сразу, а устаревшую карту освежаем в фоне — запросы из-за этого не ждут.
 */
export async function ensureLoaded(now = Date.now()) {
  if (loadedAt && now - loadedAt < REFRESH_MS) return
  if (!loadedAt) { loading = loading || reload().finally(() => { loading = null }); await loading; return }
  if (!loading) loading = reload().finally(() => { loading = null }) // фоновое обновление
}

/**
 * Токен отозван? Сравниваем момент ВЫДАЧИ токена с отметкой выхода.
 * @param {string} userId @param {number} issuedAtMs когда токен выдан
 */
/**
 * Освежить карту, если устарела. СИНХРОННАЯ и намеренно: гвард стоит на каждом запросе к
 * /api, и заставлять его ждать поход в БД ради отметки, которая меняется раз в сутки, —
 * плата не по делу. Обновление идёт фоном, запрос обслуживается на текущей карте.
 */
export function touch(now = Date.now()) {
  if (loading) return
  if (loadedAt && now - loadedAt < REFRESH_MS) return
  loading = reload().catch(() => {}).finally(() => { loading = null })
}

export function isRevoked(userId, issuedAtMs) {
  const since = cache.get(userId)
  if (since == null || !Number.isFinite(issuedAtMs)) return false
  // Строго «раньше»: токен, выданный в ту же миллисекунду, что и выход, — это уже новый
  // вход (вышел и тут же зашёл снова), и убивать его нельзя.
  return issuedAtMs < since
}

/**
 * Погасить все прежние токены человека. Зовём на выходе.
 * @param {string} userId @param {number} [now]
 */
export async function revokeTokensFor(userId, now = Date.now()) {
  if (!userId) return
  cache.set(userId, now) // в этом процессе — сразу, не дожидаясь следующего обновления
  if (memoryOnly()) return
  const db = getSupabase()
  const { error } = await db.from('profiles').update({ tokens_valid_from: new Date(now).toISOString() }).eq('legacy_id', userId)
  if (error) warnOnce('запись отметки выхода', error)
}

/** Только для тестов: забыть загруженное. */
export function __reset() { cache = new Map(); loadedAt = 0; loading = null; warned.clear() }
