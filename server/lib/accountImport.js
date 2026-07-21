/**
 * §2: движок массового импорта аккаунтов. Берёт найденное сканером, конвертирует
 * в нашу StringSession, раздаёт прокси и (по желанию) проверяет живость реальным
 * заходом в Telegram, после чего кладёт аккаунт в систему так же, как это делает
 * обычная авторизация по номеру (`tgAuth.js#finalizeAuth`).
 *
 * Правило §6 «один прокси — один аккаунт» соблюдается режимом `pool`: каждому
 * импортируемому достаётся свой свободный прокси, и если их не хватило — импорт
 * не молчит, а честно пишет это в отчёт по каждой строке.
 */
import { Api } from 'telegram'
import { toGramjsSession, ImportError } from './sessionImport.js'
import { saveSession, newAccountId, createClient } from '../tgAuth.js'
import { setAccountMeta, countryFromPhone, avatarColor, loadAllMeta } from '../accountsMeta.js'
import { accountFingerprint, takenFingerprints } from './deviceFingerprint.js'

/** Режимы раздачи прокси. */
export const PROXY_MODES = ['pool', 'single', 'sidecar', 'none']

/**
 * Раздать прокси на пачку. Чистая функция — тестируется без сети.
 * @param {object[]} items найденные аккаунты (у некоторых есть свой `proxy` из json)
 * @param {{ mode:string, proxyUrls?:string[], single?:string, busy?:Set<string> }} opts
 * @returns {(string|null)[]} прокси на каждый item в том же порядке (null = без прокси)
 */
export function distributeProxies(items, opts = {}) {
  const mode = PROXY_MODES.includes(opts.mode) ? opts.mode : 'none'
  const busy = opts.busy || new Set()
  // Пул: только те, что ещё никому не назначены — иначе нарушим «1 прокси = 1 аккаунт».
  const free = (opts.proxyUrls || []).filter((u) => u && !busy.has(u))
  let cursor = 0
  return (items || []).map((it) => {
    if (mode === 'none') return null
    if (mode === 'single') return opts.single || null
    if (mode === 'sidecar') return it.proxy || null
    // pool: свой прокси каждому, по порядку; закончились — null (в отчёте это будет видно)
    return cursor < free.length ? free[cursor++] : null
  })
}

/**
 * Импортировать один найденный аккаунт.
 * @param {object} item элемент от scanFolder
 * @param {{ proxy?:string|null, validate?:boolean, passcode?:string }} opts
 * @returns {Promise<{ ok:boolean, accountId?:string, name?:string, phone?:string, reason?:string, alive?:boolean }>}
 */
export async function importOne(item, opts = {}) {
  let session
  let self = null
  try {
    const r = await toGramjsSession({
      kind: item.kind,
      path: item.path,
      accountIdx: item.accountIdx,
      passcode: opts.passcode,
    })
    session = r.session
    self = r.self
  } catch (e) {
    return { ok: false, reason: e instanceof ImportError ? e.message : `не сконвертировался: ${e?.message || e}` }
  }

  const proxy = opts.proxy || null
  // Отпечаток: из json продавца, если он есть, иначе свой — но заведомо не совпадающий
  // с отпечатками уже заведённых аккаунтов, иначе они склеятся в одну пачку (§6).
  let has2faEnabled = null // null = не проверяли
  const taken = opts.taken || takenFingerprints(await loadAllMeta())
  const fingerprint = accountFingerprint(item.path + (item.accountIdx ?? 0), { fingerprint: item.fingerprint }, taken)
  let me = null
  if (opts.validate) {
    // Единственный способ узнать, живой ли аккаунт, — сходить в Telegram его сессией.
    // Идём ЧЕРЕЗ назначенный прокси: если аккаунт потом будет работать через него,
    // то и проверять надо оттуда же, иначе проверка ничего не доказывает.
    let client
    try {
      client = await createClient(session, proxy || undefined, fingerprint)
      me = await client.getMe()
      if (!me) return { ok: false, reason: 'Telegram не отдал профиль — сессия мертва' }
      // Заодно выясняем, включён ли облачный пароль. Спрашивать его у человека имеет
      // смысл только там, где он реально есть, — а узнать это можно лишь у Telegram.
      try {
        const pwd = await client.invoke(new Api.account.GetPassword())
        has2faEnabled = !!pwd?.hasPassword
      } catch { /* не критично: не смогли спросить — просто не знаем */ }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: /AUTH_KEY|UNAUTHORIZED|SESSION_REVOKED/i.test(msg) ? 'сессия отозвана Telegram' : `не подключился: ${msg}` }
    } finally {
      try { await client?.disconnect() } catch { /* соединение уже закрыто */ }
    }
  }

  const phone = (me?.phone ? `+${String(me.phone).replace(/^\+/, '')}` : item.phone) || ''
  const accountId = newAccountId(phone || item.name || String(Date.now()))
  await saveSession(accountId, session)

  const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || item.name || 'Аккаунт'
  await setAccountMeta(accountId, {
    proxy: proxy || '—',
    country: countryFromPhone(phone),
    status: 'active',
    inTrash: false,
    name,
    username: me?.username || '',
    phone,
    userId: Number(me?.id ?? self?.userId) || undefined,
    avatarColor: avatarColor(accountId),
    // Отпечаток храним вместе с аккаунтом: дальше ходить надо тем же устройством,
    // которым сессия создана (или которое мы ему выдали), иначе для Telegram это смена девайса.
    fingerprint,
    // Облачный пароль (2FA) из json или password.txt рядом. Без него аккаунт встанет
    // на первом же запросе подтверждения — а восстановить его потом неоткуда.
    twoFA: item.twoFA || null,
    note: `Импортирован из ${item.kind === 'tdata' ? 'tdata' : 'файла сессии'}`,
  })

  return {
    ok: true, accountId, name, phone,
    has2fa: !!item.twoFA,
    // Телеграм говорит, что пароль включён, а у нас его нет — это стоит показать:
    // такой аккаунт нельзя будет реавторизовать, если сессия отвалится.
    needsPassword: has2faEnabled === true && !item.twoFA,
    alive: opts.validate ? true : undefined,
  }
}

/**
 * Уже импортированные Telegram-аккаунты (по userId и по телефону) — чтобы не
 * заводить один и тот же аккаунт дважды при повторном сканировании папки.
 * @returns {Promise<{ userIds:Set<number>, phones:Set<string> }>}
 */
export async function existingAccountKeys() {
  const meta = await loadAllMeta()
  const userIds = new Set()
  const phones = new Set()
  for (const m of Object.values(meta || {})) {
    if (m?.userId) userIds.add(Number(m.userId))
    if (m?.phone) phones.add(String(m.phone).replace(/[^\d]/g, ''))
  }
  return { userIds, phones }
}

/** Совпадает ли найденный аккаунт с уже заведённым (по телефону — до конвертации). */
export function isKnownByPhone(keys, phone) {
  const p = String(phone || '').replace(/[^\d]/g, '')
  return !!p && keys.phones.has(p)
}
