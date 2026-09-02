/**
 * Предстартовая проверка аккаунтов задачи (§3.3).
 *
 * Раньше задача стартовала с любым набором аккаунтов и выясняла правду уже в бою: у
 * аккаунта нет сессии или прокси не пропускает Telegram — воркер крутился часами, писал
 * в лог сырые `RPC_TIMEOUT (25с)` каждые 25 секунд и не делал НИ ОДНОГО действия
 * (прогон 12.08: 30 записей в логе, 0/10 действий). Дешевле проверить заранее и сказать
 * человеку прямым текстом, что чинить.
 *
 * Проверяем только то, что стоит копейки и не ходит в Telegram: статус аккаунта, наличие
 * сессии, назначен ли прокси и не помечен ли он нерабочим. Живую пробу прокси здесь НЕ
 * делаем — она уже есть в карточке аккаунта и в каталоге, а старт задачи не должен
 * упираться в сеть.
 */
import { getAccountMeta } from '../accountsMeta.js'
import { loadSessionString } from '../tgAuth.js'
import { getProxy } from '../proxies.js'
import { isAccountRunnable } from './protection.js'

/** Сколько доверяем свежей пометке «прокси нерабочий» (как в карточке аккаунта). */
const DEAD_PROXY_TRUST_MS = 10 * 60 * 1000

/** Человеческие названия статусов — чтобы в логе было «в карантине», а не `quarantine`. */
const STATUS_RU = {
  quarantine: 'в карантине',
  spamblock: 'в спамблоке',
  invalid: 'невалиден',
  frozen: 'заморожен',
  reauth: 'нужна переавторизация',
  floodwait: 'во FloodWait',
  pause: 'на паузе',
}

/**
 * @param {string[]} accountIds
 * @returns {Promise<{ ready: string[], problems: {accountId:string,name:string,reason:string}[] }>}
 */
export async function preflightAccounts(accountIds = []) {
  const ready = []
  const problems = []
  for (const accountId of accountIds) {
    let meta = {}
    try { meta = await getAccountMeta(accountId) } catch { /* нет меты — считаем пустой */ }
    const name = meta.name || accountId
    const status = meta.status || 'active'

    if (meta.inTrash) { problems.push({ accountId, name, reason: 'аккаунт в корзине' }); continue }
    // 'working' — аккаунт уже в работе этой же задачи (перезапуск), это не проблема.
    if (status !== 'working' && !isAccountRunnable(status)) {
      problems.push({ accountId, name, reason: STATUS_RU[status] || `статус «${status}»` })
      continue
    }

    const session = await loadSessionString(accountId).catch(() => '')
    if (!session) { problems.push({ accountId, name, reason: 'нет сессии — нужна переавторизация' }); continue }

    if (!meta.proxyId) { problems.push({ accountId, name, reason: 'не назначен прокси' }); continue }

    // Прокси признан нерабочим — каталогом или последней живой проверкой карточки.
    // Берём по ссылке: поиск по строке подключения при совпадении host:port мог найти
    // ЧУЖОЙ прокси, а после смены адреса не находил нужный вовсе.
    let deadProxy = false
    try {
      const p = await getProxy(meta.proxyId)
      if (p) deadProxy = p.status === 'dead' && !!p.lastCheckAt && (Date.now() - p.lastCheckAt) < DEAD_PROXY_TRUST_MS
      else deadProxy = meta.proxyWorking === false && !!meta.proxyCheckAt && (Date.now() - meta.proxyCheckAt) < DEAD_PROXY_TRUST_MS
    } catch { /* каталог недоступен — не придираемся */ }
    if (deadProxy) { problems.push({ accountId, name, reason: 'прокси помечен нерабочим — замените' }); continue }

    ready.push(accountId)
  }
  return { ready, problems }
}

/**
 * Проверить и записать результат в лог задачи. Возвращает список готовых аккаунтов.
 * Каждая проблема — отдельной строкой WARNING с именем аккаунта: оператор должен видеть,
 * КТО именно не поедет и почему, а не общий «что-то пошло не так».
 * @param {object} task @param {object} store
 * @returns {Promise<{ ready: string[], problems: object[] }>}
 */
export async function preflightAndLog(task, store) {
  const ids = task.settings?.accountIds || []
  const { ready, problems } = await preflightAccounts(ids)
  for (const p of problems) {
    try { await store.appendLog(task, 'warning', `Аккаунт пропущен: ${p.reason}`, p.name) } catch { /* лог не должен ронять старт */ }
  }
  if (problems.length && ready.length) {
    try { await store.appendLog(task, 'info', `Проверка перед запуском: готовы ${ready.length} из ${ids.length}`) } catch { /* ignore */ }
  }
  return { ready, problems }
}
