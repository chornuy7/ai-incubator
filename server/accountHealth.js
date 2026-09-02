/**
 * ФОНОВАЯ ПРОВЕРКА ПАРКА: жив ли аккаунт на самом деле.
 *
 * Прогон 22.08 (находка Р-19): из двенадцати аккаунтов со статусом «активен» трое
 * оказались удалены Telegram (`USER_DEACTIVATED`), а у одного сессия недействительна
 * (`AUTH_KEY_UNREGISTERED`). Платформа узнавала об этом только когда аккаунт брали в
 * работу — то есть оператор планировал прогон на мёртвых профилях и видел правду уже
 * в логе задачи.
 *
 * Что делает: раз в час берёт несколько аккаунтов, которых давно не проверяли, ходит
 * ИХ ЖЕ ПРОКСИ (иначе проверка соврёт: прямое подключение с сервера может и не пройти)
 * и спрашивает `getMe`. Результат раскладывается на три случая, и это главное:
 *
 *   • аккаунт удалён/забанен Telegram      → `invalid`, работать им нельзя;
 *   • сессия больше не действительна       → `reauth`, нужен новый вход;
 *   • прокси/сеть не отвечают              → НИЧЕГО НЕ МЕНЯЕМ.
 *
 * Третий случай важнее первых двух: свалить в «невалидный» живой аккаунт из-за упавшего
 * прокси — значит выкосить пул на ровном месте. Молча пропускаем и попробуем в следующий
 * раз; за живость прокси отвечает отдельный планировщик.
 *
 * Занятых не трогаем: проверка — это ещё одно подключение той же сессией, а параллельный
 * логин роняет обе стороны.
 */
import { metaOf, setAccountMeta, setAccountStatus } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { getAccountLock } from './lib/accountLocks.js'
import { getCronSync } from './cronSettings.js'
import { accountProxyUrl } from './proxies.js'

/** Как часто перепроверять один аккаунт. */
export const HEALTH_EVERY_MS = 12 * 60 * 60 * 1000
/** Сколько аккаунтов за один тик — чтобы не выйти в сеть полусотней подключений разом. */
const PER_TICK = 5

/** Статусы, которые проверять незачем: они и так означают «не в работе». */
const SKIP_STATUSES = new Set(['invalid', 'reauth', 'frozen', 'working'])

/**
 * Что означает ошибка подключения. Разделение — суть модуля: беда аккаунта и беда
 * сети лечатся по-разному, и путать их нельзя.
 * @returns {{status:string, code:string, reason:string} | null} null — вина не аккаунта
 */
export function classifyHealthError(err) {
  const msg = `${err?.errorMessage || err?.message || ''}`
  if (/USER_DEACTIVATED|USER_BANNED|ACCOUNT_.*BAN/i.test(msg)) {
    return { status: 'invalid', code: 'USER_DEACTIVATED', reason: 'Аккаунт удалён или заблокирован Telegram' }
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY/i.test(msg)) {
    return { status: 'reauth', code: 'AUTH_KEY_UNREGISTERED', reason: 'Сессия недействительна — нужна переавторизация' }
  }
  if (/FROZEN_METHOD_INVALID|FROZEN/i.test(msg)) {
    return { status: 'frozen', code: 'FROZEN', reason: 'Аккаунт заморожен Telegram' }
  }
  // Прокси, сеть, таймаут, FloodWait — аккаунт тут ни при чём.
  return null
}

/**
 * Кого пора проверить: давно не проверяли, не занят и не в терминальном статусе.
 *
 * `allMeta` — уже прочитанная карта меты. Здесь стоял `getAccountMeta(a.id)`, то есть
 * чтение ВСЕЙ таблицы меты (а с MR-262 — и каталога прокси) на каждый аккаунт, хотя
 * нужная запись лежала в `a` прямо перед глазами.
 */
function dueAccounts(all, allMeta, now, max) {
  const out = []
  for (const a of all) {
    if (out.length >= max) break
    if (a.deletedAt || a.inTrash) continue
    const meta = metaOf(allMeta, a.id)
    if (SKIP_STATUSES.has(meta.status || 'active')) continue
    if (getAccountLock(a.id)?.holders?.length) continue // занят задачей — не лезем второй сессией
    if (Number(meta.healthCheckedAt || 0) + (getCronSync().healthEveryH ?? 12) * 3600_000 > now) continue
    out.push({ id: a.id, meta })
  }
  return out
}

/**
 * Один проход проверки.
 * @returns {Promise<{checked:number, broken:number, skipped:number}>}
 */
export async function accountHealthTick(opts = {}) {
  const perTick = opts.perTick ?? getCronSync().healthPerTick ?? PER_TICK
  const now = opts.now ?? Date.now()
  const out = { checked: 0, broken: 0, skipped: 0 }
  let all = []
  let allMeta = {}
  try {
    const { loadAllMeta } = await import('./accountsMeta.js')
    allMeta = await loadAllMeta()
    all = Object.entries(allMeta).map(([id, m]) => ({ id, ...m }))
  } catch { return out }

  for (const { id, meta } of dueAccounts(all, allMeta, now, perTick)) {
    let client = null
    try {
      const session = await loadSessionString(id)
      if (!session) {
        await setAccountStatus(id, 'reauth', { code: 'NO_SESSION', reason: 'Нет сессии — нужна переавторизация', initiator: 'system' })
        out.broken += 1
        continue
      }
      client = await createClient(session, await accountProxyUrl(meta), accountFingerprint(id, meta))
      await client.getMe()
      // Жив: помечаем время проверки, статус не трогаем — он мог быть осмысленным
      // (пауза, прогрев, карантин), и «жив» это не повод его сбрасывать.
      await setAccountMeta(id, { healthCheckedAt: Date.now(), healthError: null })
      out.checked += 1
    } catch (err) {
      const verdict = classifyHealthError(err)
      if (!verdict) {
        // Сеть или прокси — молчим и пробуем позже. Отметку времени НЕ ставим, иначе
        // мёртвый аккаунт спрячется за упавшим прокси на следующие двенадцать часов.
        await setAccountMeta(id, { healthError: `${err?.errorMessage || err?.message || 'сеть недоступна'}`.slice(0, 200) }).catch(() => {})
        out.skipped += 1
        continue
      }
      await setAccountStatus(id, verdict.status, { code: verdict.code, reason: verdict.reason, initiator: 'system' }).catch(() => {})
      await setAccountMeta(id, { healthCheckedAt: Date.now(), healthError: verdict.reason }).catch(() => {})
      out.broken += 1
    } finally {
      try { await client?.disconnect() } catch { /* уже отключён */ }
    }
  }
  return out
}

let timer = null
/** Запустить фоновую проверку парка. Тик частый, «пора или нет» решает сам аккаунт. */
export function startAccountHealthScheduler(intervalMs = (getCronSync().healthTickMin ?? 60) * 60_000) {
  if (timer) clearInterval(timer)
  const run = () => accountHealthTick()
    .then((r) => { if (r.checked || r.broken) console.log(`[health] проверено ${r.checked}, выведено ${r.broken}${r.skipped ? `, пропущено по сети ${r.skipped}` : ''}`) })
    .catch((e) => console.warn('[health] tick failed:', e?.message || e))
  timer = setInterval(run, intervalMs)
  // Не на старте: бэкенд в первые минуты и так занят прогревом кэшей и проверкой прокси.
  setTimeout(run, 5 * 60 * 1000)
  console.log('[health] фоновая проверка парка включена')
}

export function stopAccountHealthScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}
