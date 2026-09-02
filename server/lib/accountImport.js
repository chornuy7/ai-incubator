/**
 * §2: движок массового импорта аккаунтов. Берёт найденное сканером, конвертирует
 * в нашу StringSession, раздаёт прокси и (по желанию) проверяет живость реальным
 * заходом в Telegram, после чего кладёт аккаунт в систему так же, как это делает
 * обычная авторизация по номеру (`tgAuth.js#finalizeAuth`).
 *
 * Прокси можно ПЕРЕИСПОЛЬЗОВАТЬ (решение заказчика 31.07, отменяет прежнее «1 прокси =
 * 1 аккаунт»): один прокси разрешено вешать на несколько аккаунтов. Режим `pool`
 * раздаёт по кругу — сперва уникальные по порядку, при нехватке идёт на второй круг.
 * Сколько аккаунтов сидит на прокси — видно по счётчику использования (proxyUsageMap).
 */
import { Api } from 'telegram'
import { toGramjsSession, ImportError } from './sessionImport.js'
import { saveSession, newAccountId, createClient } from '../tgAuth.js'
import { setAccountMeta, countryFromPhone, avatarColor, loadAllMeta } from '../accountsMeta.js'
import { accountFingerprint, takenFingerprints } from './deviceFingerprint.js'
import { ensureProxyByUrl, proxyUrlById } from '../proxies.js'

/**
 * Режимы раздачи прокси.
 * `manual` — раскладку прислал оператор из таблицы «аккаунт ↔ прокси»: он уже видел
 * обе колонки и поправил пары руками, наше дело — не переставлять.
 */
export const PROXY_MODES = ['pool', 'single', 'sidecar', 'manual', 'none']

/**
 * Раздать прокси на пачку. Чистая функция — тестируется без сети.
 *
 * Дубли разрешены: в режиме `pool` прокси раздаются ПО КРУГУ — каждый аккаунт получает
 * прокси, при нехватке список повторяется. `busy` больше не исключает прокси (прежнее
 * «1:1» отменено), но принимается для обратной совместимости вызовов.
 * @param {object[]} items найденные аккаунты (у некоторых есть свой `proxy` из json)
 * @param {{ mode:string, proxyUrls?:string[], single?:string, busy?:Set<string>, manual?:(string|null)[] }} opts
 * @returns {(string|null)[]} прокси на каждый item в том же порядке (null = без прокси)
 */
export function distributeProxies(items, opts = {}) {
  const mode = PROXY_MODES.includes(opts.mode) ? opts.mode : 'none'
  const urls = (opts.proxyUrls || []).filter(Boolean)
  const manual = Array.isArray(opts.manual) ? opts.manual : []
  return (items || []).map((it, i) => {
    if (mode === 'none') return null
    if (mode === 'single') return opts.single || null
    if (mode === 'sidecar') return it.proxy || null
    if (mode === 'manual') return manual[i] || null
    // pool: по кругу — при нехватке прокси переиспользуем (дубли разрешены).
    return urls.length ? urls[i % urls.length] : null
  })
}

/**
 * Предложить раскладку «аккаунт ↔ прокси» ПО ПОРЯДКУ.
 *
 * Дефолт — 1 к 1 по строкам: у продавца папки и прокси обычно идут в одном порядке.
 * Но прокси теперь можно ПЕРЕИСПОЛЬЗОВАТЬ: если аккаунтов больше, чем прокси, сперва
 * раздаём уникальные по порядку, а хвост идёт на второй круг (дубли), а не остаётся
 * без прокси. Оператор дальше правит руками.
 *
 * Гео важнее порядка, если страна известна у обеих сторон: аккаунт из Украины через
 * американский IP — заметная нестыковка. При `matchGeo` сперва раскладываем по стране
 * (свободный того же гео, иначе — любой того же гео повторно), остаток — по порядку/кругу.
 *
 * @param {{country?:string}[]} accounts найденные аккаунты, в порядке находки
 * @param {{url:string, country?:string, status?:string}[]} proxies прокси, в порядке списка
 * @param {{matchGeo?:boolean, skipDead?:boolean}} [opts]
 * @returns {(string|null)[]} прокси на каждый аккаунт
 */
export function pairByOrder(accounts = [], proxies = [], opts = {}) {
  const pool = (proxies || []).filter((p) => p && p.url && (!opts.skipDead || p.status !== 'dead'))
  const out = new Array(accounts.length).fill(null)
  if (!pool.length) return out
  const used = new Set() // индексы, уже отданные БЕЗ повтора — «сначала уникальные»

  if (opts.matchGeo) {
    for (let i = 0; i < accounts.length; i++) {
      const c = String(accounts[i]?.country || '').toLowerCase()
      if (!c) continue
      let j = pool.findIndex((p, idx) => !used.has(idx) && String(p.country || '').toLowerCase() === c)
      if (j === -1) j = pool.findIndex((p) => String(p.country || '').toLowerCase() === c) // повтор того же гео
      if (j === -1) continue
      used.add(j)
      out[i] = pool[j].url
    }
  }

  // Остаток: сперва ещё не отданные уникальные по порядку, затем — по кругу (дубли).
  let cursor = 0
  for (let i = 0; i < accounts.length; i++) {
    if (out[i]) continue
    while (cursor < pool.length && used.has(cursor)) cursor++
    if (cursor < pool.length) {
      used.add(cursor)
      out[i] = pool[cursor].url
    } else {
      out[i] = pool[i % pool.length].url // всех уникальных раздали — на второй круг
    }
  }
  return out
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
  let source = item.kind
  // passcode приоритетно берём у самого аккаунта (список/поле в форме), иначе общий из формы.
  const passcode = item.passcode || opts.passcode
  try {
    const r = await toGramjsSession({
      kind: item.kind,
      path: item.path,
      accountIdx: item.accountIdx,
      passcode,
    })
    session = r.session
    self = r.self
  } catch (e) {
    const em = (x) => (x instanceof ImportError ? x.message : `не сконвертировался: ${x?.message || x}`)
    // tdata не открылась (passcode/битая), но рядом есть `.session` — ему пароль tdata
    // не нужен. Пробуем его: продавцы кладут оба формата как раз на этот случай.
    if (item.kind === 'tdata' && item.altSession) {
      try {
        const r2 = await toGramjsSession({ kind: 'session-file', path: item.altSession })
        session = r2.session
        self = r2.self
        source = 'session-file'
      } catch (e2) {
        return { ok: false, reason: `tdata: ${em(e)}; .session рядом тоже не зашла: ${em(e2)}` }
      }
    } else {
      return { ok: false, reason: em(e) }
    }
  }

  /*
   * MR-290: аккаунт связывается с прокси ССЫЛКОЙ, а не строкой.
   *
   * Сюда приходит либо идентификатор из каталога (режимы «пул» и «один на всех»), либо
   * строка подключения — из json продавца рядом с сессией или вписанная оператором.
   * Строку сначала превращаем в запись каталога: раньше она оседала прямо в мете, и
   * получался прокси, которого нет в списке, но который используется.
   *
   * Сам URL нужен здесь ровно один раз — чтобы проверить аккаунт ЧЕРЕЗ тот же прокси,
   * на котором он потом будет работать. В базу он не попадает.
   */
  const assigned = opts.proxy || null
  const proxyId = assigned
    ? (assigned.includes('://') ? await ensureProxyByUrl(assigned, opts.ownerId) : assigned)
    : null
  const proxy = proxyId ? await proxyUrlById(proxyId) : null
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

  // MR-290: СНАЧАЛА мета, потом сессия. Сессия теперь строка таблицы `account_sessions`
  // с внешним ключом на аккаунт — без строки аккаунта ей не на что ссылаться. Порядок
  // и по смыслу правильнее: сперва появляется аккаунт, потом у него появляется доступ.
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || item.name || 'Аккаунт'
  await setAccountMeta(accountId, {
    // Чей это аккаунт (правка 18.08). Без владельца он не покажется никому, кроме
    // админа: список аккаунтов теперь режется по пространству.
    ...(opts.ownerId ? { ownerId: String(opts.ownerId) } : {}),
    // Ссылка, а не строка: строка подключения собирается из каталога при чтении меты.
    proxyId: proxyId || undefined,
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
    /*
     * Происхождение — КОД, а не фраза. Раньше сюда уезжала строка «Импортирован из
     * tdata», и она занимала `note` — поле оператора. Сорок семь аккаунтов на боевом
     * стояли с чужой заметкой, а своя им была уже некуда.
     */
    originCode: source === 'tdata' ? 'IMPORT_TDATA' : 'IMPORT_SESSION',
    originParams: source !== item.kind ? { fallback: 'tdata_locked_used_session' } : {},
  })

  await saveSession(accountId, session)

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
