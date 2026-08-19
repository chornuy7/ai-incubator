import fs from 'fs/promises'
import path from 'path'
import { SESSIONS_DIR } from './config.js'
import { loadAllMeta, getAccountMeta, setAccountMeta, deleteAccountMeta, countryFromPhone, avatarColor } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { getAccountLock } from './lib/accountLocks.js'
import { getAllTrustCache } from './lib/trustCache.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { computeAccountRisk } from './lib/accountRisk.js'
import { cachedProxyVerdict } from './accountStats.js'

async function listSessionIds() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  const files = await fs.readdir(SESSIONS_DIR)
  return files.filter((f) => f.endsWith('.session')).map((f) => f.replace(/\.session$/, ''))
}

function formatLastSeen(ts) {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} д`
}

/** @param {string} accountId @param {object} meta @param {object | null} me @param {boolean} sessionOk */
function toAccountDto(accountId, meta, me, sessionOk) {
  const phone = me?.phone || meta.phone || ''
  const first = me?.firstName || ''
  const last = me?.lastName || ''
  const name = `${first} ${last}`.trim() || meta.name || phone || accountId

  let status = meta.status || 'active'
  if (!sessionOk) status = 'reauth'
  else if (sessionOk && status === 'reauth') status = 'active'
  // Спамблок хранится ОТДЕЛЬНЫМ полем (результат проверки @SpamBot, accountStats), и в
  // карточке он виден, а в списке/счётчике «Спамблок» — нет: аккаунт светился «Активные».
  // Отражаем блокировку как статус, если базовый статус рабочий — тогда строка, KPI-счётчик
  // и действие «Снять спамблок» его видят. Снимется сам, когда проверка вернёт 'clean'.
  if (meta.spamblock === 'blocked' && ['active', 'working', 'warming', 'pause'].includes(status)) status = 'spamblock'

  return {
    id: accountId,
    tgSessionId: accountId,
    avatarColor: meta.avatarColor || avatarColor(accountId),
    name,
    phone: phone && !phone.startsWith('+') ? `+${phone}` : phone || '—',
    username: me?.username || meta.username || `user_${accountId.slice(-6)}`,
    userId: me?.id?.toString?.() ?? meta.userId ?? '',
    role: meta.role || 'Резерв',
    project: meta.project || 'incubator_ai',
    country: meta.country || countryFromPhone(phone),
    status,
    lastSeen: formatLastSeen(meta.updatedAt || meta.createdAt),
    proxy: meta.proxy || '—',
    // note патчится через PATCH /accounts/:id, но в DTO его не было — заметка
    // сохранялась и пропадала. Нужна, в частности, чтобы видеть источник импорта.
    note: meta.note || '',
    // Сам облачный пароль наружу НЕ отдаём (API у нас fail-open) — только признак,
    // что он у нас есть: этого достаточно, чтобы видеть, где реавторизация возможна.
    has2fa: !!meta.twoFA,
    inTrash: !!meta.inTrash,
    // Временные статусы (спамблок/флудвейт/карантин) сами спадают по сроку — без него
    // оператор видит «спамблок» и не знает, ждать ему или списывать аккаунт.
    statusUntil: typeof meta.statusUntil === 'number' ? meta.statusUntil : null,
    statusReason: meta.statusReason || '',
    // MR: последняя явная проверка живости (дата + результат). null — ни разу не проверяли
    // через ?verify — тогда карточка честно показывает «не проверялся».
    lastCheckedAt: typeof meta.lastCheckedAt === 'number' ? meta.lastCheckedAt : null,
    lastCheckOk: typeof meta.lastCheckOk === 'boolean' ? meta.lastCheckOk : null,
    createdAt: meta.createdAt || Date.now(),
    busyIn: (() => {
      const lock = getAccountLock(accountId)
      return lock ? { moduleKey: lock.moduleKey, taskId: lock.taskId, moduleLabel: lock.moduleLabel } : undefined
    })(),
  }
}

/**
 * Список аккаунтов.
 *
 * `verify` — сходить в Telegram за каждым аккаунтом и обновить профиль/статус сессии.
 * По умолчанию ВЫКЛЮЧЕНО: это по подключению на аккаунт, и на полусотне аккаунтов
 * страница менеджера открывалась две с половиной минуты. Профиль (имя, username,
 * телефон, userId) и так лежит в meta с прошлой удачной проверки, поэтому обычный
 * список отдаётся мгновенно, а проверку живости запускают отдельно и осознанно.
 * @param {{ verify?: boolean }} [opts]
 */
/**
 * Кому принадлежит аккаунт (правка 18.08).
 *
 * Поля владельца у аккаунтов не было вовсе — продукт начинался как одно пространство,
 * наше. С самостоятельными регистрациями это стало утечкой: `/api/tg/accounts` отдавал
 * ВСЕ аккаунты платформы любому вошедшему, вместе с телефонами.
 *
 * Аккаунты, заведённые до этой правки, владельца не имеют — они наши, поэтому видны
 * только админу. Новые получают `ownerId` при заведении.
 */
function accountBelongsTo(meta, ownerId) {
  const owner = String(meta?.ownerId || '')
  return owner ? owner === String(ownerId || '') : false
}

export async function tgListAccounts(opts = {}) {
  const verify = opts.verify === true
  // Без ownerId (админ, дев без сессии, внутренние вызовы) фильтра нет — иначе воркеры
  // и админ-панель перестали бы видеть аккаунты, с которыми работают.
  const ownerId = opts.ownerId ? String(opts.ownerId) : null
  const ids = await listSessionIds()
  const accounts = []
  const trustAll = await getAllTrustCache()

  for (const accountId of ids) {
    let meta = await getAccountMeta(accountId)
    if (ownerId && !accountBelongsTo(meta, ownerId)) continue
    const sessionStr = await loadSessionString(accountId)
    if (!sessionStr) continue

    let me = null
    // Без проверки считаем сессию рабочей: файл на месте, а реальный вердикт даст
    // либо запуск модуля, либо явная проверка. Иначе все аккаунты уехали бы в reauth.
    let sessionOk = true
    if (verify) {
      try {
        const client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
        me = await client.getMe()
        sessionOk = true
        await client.disconnect()

        meta = await setAccountMeta(accountId, {
          name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
          username: me.username,
          phone: me.phone,
          userId: me.id?.toString?.(),
          // MR: фиксируем факт и результат явной проверки живости — иначе оператор
          // не видит, когда аккаунт последний раз проверялся и чем закончилось.
          lastCheckedAt: Date.now(),
          lastCheckOk: true,
          ...(meta.status === 'reauth' ? { status: 'active' } : {}),
        })
      } catch {
        sessionOk = false
        // Результат проверки сохраняем и при провале (сессия/прокси не ответили) —
        // статус НЕ форсим в reauth (провал может быть транзиентным, прокси/сеть):
        // это отдельная сознательная проверка, а не приговор аккаунту.
        meta = await setAccountMeta(accountId, { lastCheckedAt: Date.now(), lastCheckOk: false })
      }
    }

    const dto = toAccountDto(accountId, meta, me, sessionOk)
    const t = trustAll[accountId]
    if (t) { dto.trustScore = t.score; dto.trustBand = t.band }
    // §6.3 (AM-002): прокси «рабочий», если его нет (прямое подключение) либо он не 'dead'.
    // Ручной прокси не из каталога → статус неизвестен → не помечаем нерабочим (не прячем зря).
    const purl = meta.proxy && meta.proxy !== '—' ? meta.proxy : null
    // ЕДИНЫЙ источник правды с вкладкой «Прокси» (важно: раньше здесь противоречие).
    // Вкладка карточки показывает «Работает / Не отвечает» через cachedProxyVerdict
    // (accountStats.buildAccountStats). Список же считал свой proxyOk по другой формуле
    // (isUsableProxy(каталог) && meta.proxyWorking!==false) — и они расходились: каталог
    // «ok», но stale meta.proxyWorking=false → шапка/риск «прокси не отвечает», а вкладка
    // «Работает» (и наоборот). Теперь ОБА зовут одну функцию → противоречие исключено.
    // Вердикт: 'down' → нерабочий; 'ok'/null (ещё не проверен) → не пугаем «не отвечает».
    const proxyVerdict = purl ? await cachedProxyVerdict(purl, meta) : null
    dto.proxyOk = !purl || proxyVerdict !== 'down'
    // MR-131: прокси мёртв ИЛИ отсутствует — обе ситуации риск, но разные (разделяем).
    dto.noProxy = !purl
    dto.risk = computeAccountRisk({ status: dto.status, proxyOk: dto.proxyOk, noProxy: dto.noProxy, trustBand: dto.trustBand })
    accounts.push(dto)
  }

  accounts.sort((a, b) => b.createdAt - a.createdAt)
  return dedupeAccounts(accounts)
}

/**
 * Схлопывает дубли: одна и та же Telegram-личность может иметь несколько файлов сессии
 * (например после реавторизации). Оставляем ОДИН аккаунт на реальный userId
 * (запасные ключи — телефон, затем username). Файлы сессий не трогаем — только список.
 */
function dedupeAccounts(accounts) {
  const identityKey = (a) => {
    if (a.userId) return `uid:${a.userId}`
    if (a.phone && a.phone !== '—') return `tel:${a.phone.replace(/\D/g, '')}`
    if (a.username && !a.username.startsWith('user_')) return `usr:${a.username.toLowerCase()}`
    return `id:${a.id}`
  }
  // Чем выше балл, тем «лучше» запись: не в корзине > валидная сессия > есть прокси.
  const score = (a) =>
    (a.inTrash ? 0 : 4) +
    (a.status !== 'reauth' && a.status !== 'invalid' ? 2 : 0) +
    (a.proxy && a.proxy !== '—' ? 1 : 0)

  const byKey = new Map()
  for (const a of accounts) {
    const key = identityKey(a)
    const prev = byKey.get(key)
    if (!prev) { byKey.set(key, a); continue }
    const better = score(a) > score(prev) || (score(a) === score(prev) && (a.createdAt || 0) > (prev.createdAt || 0))
    if (better) byKey.set(key, a)
  }
  return [...byKey.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export async function tgPatchAccount(accountId, patch) {
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) throw new Error('Аккаунт не найден')

  const allowed = ['role', 'project', 'country', 'status', 'proxy', 'inTrash', 'note']
  /** @type {Record<string, unknown>} */
  const clean = {}
  for (const k of allowed) {
    if (patch[k] !== undefined) clean[k] = patch[k]
  }
  await setAccountMeta(accountId, clean)
  const accounts = await tgListAccounts()
  return accounts.find((a) => a.id === accountId)
}

export async function tgDeleteAccount(accountId) {
  const sessionPath = path.join(SESSIONS_DIR, `${accountId}.session`)
  try {
    await fs.unlink(sessionPath)
  } catch {
    /* already gone */
  }
  await deleteAccountMeta(accountId)
}

export async function tgEmptyTrash() {
  const allMeta = await loadAllMeta()
  const trashed = Object.entries(allMeta).filter(([, m]) => m.inTrash).map(([id]) => id)
  for (const id of trashed) await tgDeleteAccount(id)
  return trashed.length
}
