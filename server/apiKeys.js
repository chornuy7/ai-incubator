/**
 * §10.3 / §11.8: доступ к приватному API «мозгов» — по СЕРВИСНОМУ ключу из окружения.
 *
 * Ключи ПОД ПОЛЬЗОВАТЕЛЯ больше не выпускаются (это была ошибка трактовки, §11.8):
 * «мозги» — это сервер проекта, а не юзеры. Единственный ключ живёт только в env
 * (`MURMEX_API_KEY`), в админке его не создать и не выбрать. Здесь остаётся:
 *   • verifyKey — пускает по env-ключу (и по легаси-ключам из БД/файла, если такие
 *     ещё есть, — для обратной совместимости; таблица api_keys штатно пуста);
 *   • listKeys / revokeKey — посмотреть и ОТОЗВАТЬ любой оставшийся легаси-ключ
 *     (управление, не генерация).
 * Проверка легаси-ключа — по полному значению из заголовка Authorization.
 */
import crypto from 'node:crypto'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

const KEYS_FILE = () => process.env.API_KEYS_FILE || dataPath('api-keys.json')

/** Префикс — чтобы ключ узнавался в логах и не путался с чужими токенами. */
const PREFIX = 'aii_live_sk_'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex')

// ── Сервисный ключ из окружения (§10.3) ──────────────────────────────────────
// «Мозги» проекта — один ключ на всю систему, живёт ТОЛЬКО в env, в админке не
// выпускается и не выбирается. Задаётся `MURMEX_API_KEY` (или `API_SERVICE_KEY`).
// Личность: если задан `MURMEX_API_KEY_OWNER` — ключ действует от имени этого
// пользователя (его RBAC); иначе — системный полный доступ (как дев/демо без
// сессии). Сам ключ и есть замок: пройти requireApiKey без него нельзя.
const ENV_KEY = () => (process.env.MURMEX_API_KEY || process.env.API_SERVICE_KEY || '').trim()
const ENV_KEY_OWNER = () => (process.env.MURMEX_API_KEY_OWNER || '').trim()

/** Задан ли сервисный env-ключ (для подсказок в документации/UI). */
export function serviceKeyConfigured() {
  return !!ENV_KEY()
}

/** Совпадает ли токен с сервисным env-ключом — константное сравнение по времени. */
function matchesEnvKey(token) {
  const env = ENV_KEY()
  if (!env || !token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(env)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** @returns {Promise<Array<object>>} */
export async function listKeys() {
  const db = sb()
  if (db) {
    const { data } = await db.from('api_keys').select('id, name, prefix, owner_id, created_at, last_used_at, revoked').order('created_at', { ascending: false })
    return (data || []).map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, ownerId: k.owner_id || '',
      createdAt: k.created_at ? new Date(k.created_at).getTime() : 0,
      lastUsedAt: k.last_used_at ? new Date(k.last_used_at).getTime() : 0, revoked: !!k.revoked,
    }))
  }
  const raw = await readJson(KEYS_FILE(), [])
  const arr = Array.isArray(raw) ? raw : []
  // Наружу — без секрета: только префикс для узнавания + для какого пользователя ключ.
  return arr.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, ownerId: k.ownerId || '', createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || 0, revoked: !!k.revoked,
  }))
}

/** Отозвать ключ (мягко: помечаем revoked, чтобы аудит помнил, что он был). */
export async function revokeKey(id) {
  const db = sb()
  if (db) {
    const { data } = await db.from('api_keys').update({ revoked: true }).eq('id', id).select('id')
    return !!(data && data.length)
  }
  let found = false
  await mutateJson(KEYS_FILE(), (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return arr.map((k) => {
      if (k.id === id) { found = true; return { ...k, revoked: true } }
      return k
    })
  }, [])
  return found
}

/**
 * Проверить ключ из заголовка. Возвращает запись или null. Обновляет lastUsedAt.
 * @param {string} raw значение Authorization (с «Bearer » или без)
 */
export async function verifyKey(raw) {
  const token = String(raw || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  // Сервисный env-ключ — раньше всего: не в БД, не требует префикса, один на систему.
  if (matchesEnvKey(token)) {
    return { id: 'env', name: 'Сервисный ключ (env)', ownerId: ENV_KEY_OWNER(), service: true }
  }
  if (!token.startsWith(PREFIX)) return null
  const db = sb()
  if (db) {
    const { data: rec } = await db.from('api_keys').select('id, name, owner_id').eq('key_hash', hash(token)).eq('revoked', false).maybeSingle()
    if (!rec) return null
    db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', rec.id).then(() => {}, () => {})
    return { id: rec.id, name: rec.name, ownerId: rec.owner_id || '' }
  }
  const arr = await readJson(KEYS_FILE(), [])
  const rec = (Array.isArray(arr) ? arr : []).find((k) => k.key === token && !k.revoked)
  if (!rec) return null
  // Отметку «последнее использование» пишем best-effort, не роняя запрос.
  mutateJson(KEYS_FILE(), (r) => (Array.isArray(r) ? r : []).map((k) => (k.id === rec.id ? { ...k, lastUsedAt: Date.now() } : k)), []).catch(() => {})
  return { id: rec.id, name: rec.name, ownerId: rec.ownerId }
}

/**
 * Express-middleware: пускает только с валидным ключом. Кладёт req.apiKey.
 * Отдельный слой от сессионного x-user-id: «мозги» ходят ключом, а не логином.
 */
export function requireApiKey() {
  return async (req, res, next) => {
    const key = await verifyKey(req.header('authorization'))
    if (!key) return res.status(401).json({ ok: false, error: 'Нужен действующий API-ключ (Authorization: Bearer …)' })
    req.apiKey = key
    next()
  }
}
