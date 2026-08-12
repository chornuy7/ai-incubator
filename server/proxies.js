/**
 * Сущность «Прокси» (§3.2/3.4). Каталог прокси для привязки к аккаунтам.
 * Модель поддерживает решение заказчика (14.07): своя ферма + докупаемые (static/mobile).
 * account.proxy хранит URL-строку (её парсит server/proxy.js#parseProxy для GramJS);
 * `toProxyUrl` строит эту строку из сущности — мост между каталогом и назначением на аккаунт.
 * Хранение — JSON data/proxies.json; путь через env PROXIES_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import net from 'net'
import { SocksClient } from 'socks'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const PROXIES_FILE = process.env.PROXIES_FILE || dataPath('proxies.json')

export const PROXY_KINDS = ['static', 'mobile', 'farm'] // статический / мобильный / своя ферма
export const PROXY_SCHEMES = ['socks5', 'http']
/**
 * `bad` — порт открыт, но выйти наружу через прокси не удалось: чаще всего это
 * неверная схема (socks5 вместо http). Раньше такой прокси показывался как `ok`,
 * потому что живость мерилась TCP-пингом, а порт открыт всегда (баг 2, 21.07).
 */
export const PROXY_STATUSES = ['ok', 'bad', 'dead', 'unknown']

/** Построить URL-строку прокси (совместимо с parseProxy). @param {object} p */
export function toProxyUrl(p) {
  if (!p || !p.host || !p.port) return ''
  const scheme = PROXY_SCHEMES.includes(p.scheme) ? p.scheme : 'socks5'
  const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@` : ''
  return `${scheme}://${auth}${p.host}:${p.port}`
}

/** Нормализовать вход в чистую запись прокси. @param {object} input */
export function normalizeProxy(input = {}) {
  return {
    label: String(input.label ?? '').trim(),
    kind: PROXY_KINDS.includes(input.kind) ? input.kind : 'static',
    scheme: PROXY_SCHEMES.includes(input.scheme) ? input.scheme : 'socks5',
    host: String(input.host ?? '').trim(),
    port: Math.max(0, Math.floor(Number(input.port) || 0)),
    username: String(input.username ?? '').trim(),
    password: String(input.password ?? ''),
    country: String(input.country ?? '').trim().toLowerCase(),
    // Откуда взята страна: 'exit' — гео РЕАЛЬНОГО выходного IP (запрос ушёл через прокси),
    // 'gateway' — гео адреса шлюза, то есть «примерно». Без этого поля интерфейс не мог
    // отличить одно от другого и показывал страну сервера как страну выхода (тест 9.4).
    geoSource: ['exit', 'gateway'].includes(input.geoSource) ? input.geoSource : null,
    // Ссылка смены IP от продавца (…/changeip/<token>) — приходит вместе со списком
    // при импорте и раньше считалась ошибкой формата (тест 9.11).
    rotateUrl: String(input.rotateUrl ?? '').trim(),
    status: PROXY_STATUSES.includes(input.status) ? input.status : 'unknown',
    // Почему статус такой: 'no_telegram' — наружу ходит, но в Telegram не пускает,
    // 'protocol' — не тот протокол, 'unreachable' — хост мёртв. Без причины «Нерабочий»
    // ничего не объясняет, а именно она решает, менять прокси или схему.
    reason: String(input.reason ?? ''),
    note: String(input.note ?? ''),
  }
}

export async function listProxies() {
  const arr = await readJson(PROXIES_FILE, [])
  return Array.isArray(arr) ? arr : []
}

export async function getProxy(id) {
  return (await listProxies()).find((p) => p.id === id) || null
}

/** @param {object} input @throws при пустом host/port */
export async function createProxy(input) {
  const clean = normalizeProxy(input)
  if (!clean.host || !clean.port) throw new Error('Укажите host и port')
  const all = await listProxies()
  const proxy = {
    id: `px_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    lastCheckAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(proxy)
  await writeJson(PROXIES_FILE, all)
  return proxy
}

/** @param {string} id @param {object} patch */
export async function updateProxy(id, patch = {}) {
  const all = await listProxies()
  const i = all.findIndex((p) => p.id === id)
  if (i === -1) return null
  const clean = normalizeProxy({ ...all[i], ...patch })
  if (!clean.host || !clean.port) throw new Error('Host и port обязательны')
  const next = { ...all[i], ...clean, updatedAt: Date.now() }
  // normalizeProxy не знает про lastCheckAt — сохраняем его из патча явно (иначе теряется).
  if (patch.lastCheckAt !== undefined) next.lastCheckAt = patch.lastCheckAt
  all[i] = next
  await writeJson(PROXIES_FILE, all)
  return all[i]
}

export async function deleteProxy(id) {
  const all = await listProxies()
  const next = all.filter((p) => p.id !== id)
  if (next.length === all.length) return false
  await writeJson(PROXIES_FILE, next)
  return true
}

// ── §6: авто-проверка живости прокси ──────────────────────────────────

/** TCP-пинг host:port с таймаутом — доступен ли endpoint прокси. @returns {Promise<boolean>} */
export function tcpPing(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve(false)
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy() } catch { /* noop */ } resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try { sock.connect(Number(port), String(host)) } catch { finish(false) }
  })
}

/**
 * Проверка на уровне ПРОТОКОЛА, а не только открытого порта.
 *
 * TCP-пинг говорит лишь «на этом порту кто-то слушает» — а слушать может сервис,
 * который данной схемой не разговаривает (тест 9.2: http-прокси, записанный как
 * socks5, проходил TCP-пинг). SOCKS5: приветствие 05 01 00 → ответ с 0x05.
 * HTTP(S): CONNECT → статус-строка (200/407/403). SOCKS4: остаёмся на TCP-пинге.
 * @param {{scheme?:string, host:string, port:number|string}} p @returns {Promise<boolean>}
 */
export function probeProxyProtocol(p, timeoutMs = 6000) {
  const scheme = String(p?.scheme || 'socks5').toLowerCase()
  if (scheme === 'socks4') return tcpPing(p.host, p.port, timeoutMs)
  return new Promise((resolve) => {
    if (!p?.host || !p?.port) return resolve(false)
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy() } catch { /* noop */ } resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.once('connect', () => {
      if (scheme === 'socks5') sock.write(Buffer.from([0x05, 0x01, 0x00]))
      else sock.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`)
    })
    sock.once('data', (buf) => {
      if (scheme === 'socks5') return finish(buf.length >= 2 && buf[0] === 0x05)
      const head = buf.toString('latin1', 0, 64)
      finish(/^HTTP\/1\.[01] (2\d\d|40[37])/.test(head))
    })
    try { sock.connect(Number(p.port), String(p.host)) } catch { finish(false) }
  })
}

/**
 * Дата-центры Telegram (адреса стабильны и публичны). Проверяем доступность именно их:
 * прокси может прекрасно ходить в обычный интернет и при этом не пускать в Telegram —
 * тогда аккаунты через него молча висят на таймаутах.
 */
const TG_DCS = [
  { host: '149.154.167.51', port: 443 }, // DC2, Amsterdam
  { host: '149.154.175.53', port: 443 }, // DC1, Miami
]

/**
 * Пускает ли прокси в Telegram: пробуем установить соединение с ДЦ Telegram ЧЕРЕЗ прокси.
 *
 * Ради этого всё и затевалось: раньше «Рабочий» означал «через прокси открылся ip-api.com»,
 * из-за чего полсотни канадских прокси числились рабочими, а задачи на них не делали
 * ничего и сыпали таймаутами (прогон 12.08).
 * @param {object} proxy @param {number} [timeoutMs] @returns {Promise<boolean>}
 */
export async function probeTelegramThroughProxy(proxy = {}, timeoutMs = 8000) {
  const host = String(proxy.host || '')
  const port = Number(proxy.port || 0)
  if (!host || !port) return false
  const scheme = proxy.scheme || (proxy.socksType === 4 ? 'socks4' : 'socks5')
  for (const dc of TG_DCS) {
    try {
      if (scheme === 'socks5' || scheme === 'socks4') {
        const info = await SocksClient.createConnection({
          proxy: { host, port, type: scheme === 'socks4' ? 4 : 5, userId: proxy.username || undefined, password: proxy.password || undefined },
          command: 'connect',
          destination: { host: dc.host, port: dc.port },
          timeout: timeoutMs,
        })
        try { info.socket.destroy() } catch { /* noop */ }
        return true
      }
      // HTTP-прокси: CONNECT до ДЦ; успех — статус 200.
      const ok = await new Promise((resolve) => {
        const sock = net.connect(port, host)
        let done = false
        const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch { /* noop */ } resolve(v) }
        sock.setTimeout(timeoutMs, () => finish(false))
        sock.once('error', () => finish(false))
        sock.once('connect', () => {
          const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n` : ''
          sock.write(`CONNECT ${dc.host}:${dc.port} HTTP/1.1\r\nHost: ${dc.host}:${dc.port}\r\n${auth}\r\n`)
        })
        sock.once('data', (buf) => finish(/^HTTP\/1\.[01] 2\d\d/.test(buf.toString('latin1', 0, 32))))
      })
      if (ok) return true
    } catch { /* пробуем следующий ДЦ */ }
  }
  return false
}

/**
 * Проверить прокси по-настоящему: протокольное рукопожатие (отсекает «не тот протокол»),
 * затем ДОСТУПНОСТЬ TELEGRAM через него, и уже потом гео. Порт открыт, но наружу не
 * пускает → `bad`; наружу ходит, а в Telegram не пускает → тоже `bad`, но с причиной
 * `no_telegram`: для платформы такой прокси бесполезен, и он обязан попасть в «нерабочие».
 * @param {object} p @param {number} [timeoutMs]
 * @returns {Promise<{status:string, geo:object|null, geoSource:string|null, reason?:string}>}
 */
export async function probeProxy(p, timeoutMs = 9000) {
  const speaks = await probeProxyProtocol(p, Math.min(timeoutMs, 6000))
  if (!speaks) {
    // Хост вообще не отвечает — dead; отвечает, но не тем протоколом — bad.
    const reachable = await tcpPing(p.host, p.port, Math.min(timeoutMs, 6000))
    if (!reachable) return { status: 'dead', geo: null, geoSource: null, reason: 'unreachable' }
    const gw = await probeProxyGeo(p.host, Math.min(timeoutMs, 6000))
    return { status: 'bad', geo: gw, geoSource: gw ? 'gateway' : null, reason: 'protocol' }
  }
  const tgOk = await probeTelegramThroughProxy(p, Math.min(timeoutMs, 8000))
  const exit = await probeProxyExitGeo(p, timeoutMs)
  const geo = exit || await probeProxyGeo(p.host, Math.min(timeoutMs, 6000))
  const geoSource = exit ? 'exit' : (geo ? 'gateway' : null)
  if (!tgOk) return { status: 'bad', geo, geoSource, reason: 'no_telegram' }
  return { status: 'ok', geo, geoSource, reason: '' }
}

/** Проверить один прокси и записать статус + актуальные гео/geoSource. */
export async function checkProxyLiveness(id, timeoutMs = 9000) {
  const p = await getProxy(id)
  if (!p) return null
  const { status, geo, geoSource, reason } = await probeProxy(p, timeoutMs)
  return updateProxy(id, {
    status,
    reason: reason || '',
    lastCheckAt: Date.now(),
    ...(geo ? { country: geo.country || p.country, geoSource, note: geoNote(geo) } : {}),
  })
}

/** Человекочитаемая подпись гео — она же уходит в `note`, чтобы не расходилась со страной. */
export function geoNote(geo) {
  if (!geo) return ''
  return [geo.countryName || geo.country, geo.city, geo.isp].filter(Boolean).join(' · ')
}

/** GeoIP по IP прокси (ip-api.com, без ключа) — страна/город/провайдер. Best-effort. */
export async function probeProxyGeo(host, timeoutMs = 6000) {
  if (!host) return null
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,country,countryCode,city,isp,query`, { signal: ctrl.signal })
    clearTimeout(to)
    const d = await res.json().catch(() => null)
    if (!d || d.status !== 'success') return null
    return {
      country: d.countryCode ? String(d.countryCode).toLowerCase() : '',
      countryName: d.country || '',
      city: d.city || '',
      isp: d.isp || '',
      ip: d.query || host,
    }
  } catch { return null }
}

const IP_API_PATH = '/json/?fields=status,country,countryCode,city,isp,query'

/** Собрать ответ из сокета (до close/timeout) в строку. */
function readSocketBody(socket, timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = () => { if (done) return; done = true; try { socket.destroy() } catch { /* noop */ } resolve(buf) }
    socket.setTimeout?.(timeoutMs, finish)
    socket.on('data', (d) => { buf += d.toString('utf8'); if (buf.length > 65536) finish() })
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', finish)
  })
}

/** Вытащить JSON-объект гео из HTTP-ответа ip-api. */
function parseGeoBody(raw) {
  const i = raw.indexOf('{'); const j = raw.lastIndexOf('}')
  if (i === -1 || j <= i) return null
  let d
  try { d = JSON.parse(raw.slice(i, j + 1)) } catch { return null }
  if (!d || d.status !== 'success') return null
  return {
    country: d.countryCode ? String(d.countryCode).toLowerCase() : '',
    countryName: d.country || '',
    city: d.city || '',
    isp: d.isp || '',
    ip: d.query || '',
  }
}

/**
 * Гео РЕАЛЬНОГО выходного IP прокси — запрос к ip-api ЧЕРЕЗ сам прокси (§3.4).
 * Важно: у мобильных/резидентных прокси хост-шлюз (дата-центр провайдера) != страна выхода,
 * поэтому геолоцируем именно выход, а не адрес шлюза. Возвращает null при ошибке/таймауте.
 * @param {{scheme?:string,host:string,port:number,username?:string,password?:string,socksType?:number}} proxy
 */
export async function probeProxyExitGeo(proxy = {}, timeoutMs = 9000) {
  const host = String(proxy.host || '')
  const port = Number(proxy.port || 0)
  if (!host || !port) return null
  const scheme = proxy.scheme || (proxy.socksType === 4 ? 'socks4' : 'socks5')
  try {
    let socket
    if (scheme === 'socks5' || scheme === 'socks4') {
      const info = await SocksClient.createConnection({
        proxy: { host, port, type: scheme === 'socks4' ? 4 : 5, userId: proxy.username || undefined, password: proxy.password || undefined },
        command: 'connect',
        destination: { host: 'ip-api.com', port: 80 },
        timeout: timeoutMs,
      })
      socket = info.socket
      socket.write(`GET ${IP_API_PATH} HTTP/1.1\r\nHost: ip-api.com\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`)
    } else {
      // HTTP-прокси: полный URL + Proxy-Authorization.
      socket = net.connect(port, host)
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
        socket.setTimeout(timeoutMs, () => reject(new Error('timeout')))
      })
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n` : ''
      socket.write(`GET http://ip-api.com${IP_API_PATH} HTTP/1.1\r\nHost: ip-api.com\r\n${auth}User-Agent: curl/8\r\nConnection: close\r\n\r\n`)
    }
    return parseGeoBody(await readSocketBody(socket, timeoutMs))
  } catch { return null }
}

/**
 * Проверить все прокси (последовательно, чтобы не открывать сотни сокетов разом).
 *
 * Обновляет и гео тоже: раньше кнопка трогала только статус, поэтому после починки
 * схемы страна оставалась старой и неверной, а `note` противоречил `country` (баг 5).
 */
export async function checkAllProxies(timeoutMs = 9000) {
  const all = await listProxies()
  const results = []
  // Пачками: проба теперь ходит наружу через каждый прокси (секунды), и полсотни
  // подряд — это минуты. Но и все разом открывать нельзя: сотня сокетов на ровном месте.
  const BATCH = 8
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH)
    const probed = await Promise.all(batch.map((p) => probeProxy(p, timeoutMs).catch(() => ({ status: 'dead', geo: null, geoSource: null }))))
    // Запись — по одному: `updateProxy` читает-меняет-пишет общий файл,
    // параллельные записи затирали бы друг друга.
    for (let k = 0; k < batch.length; k += 1) {
      const p = batch[k]
      const { status, geo, geoSource, reason } = probed[k]
      try {
        await updateProxy(p.id, {
          status,
          reason: reason || '',
          lastCheckAt: Date.now(),
          ...(geo ? { country: geo.country || p.country, geoSource, note: geoNote(geo) } : {}),
        })
      } catch { /* skip */ }
      results.push({ id: p.id, status, reason: reason || '', country: geo?.country || p.country || '', geoSource })
    }
  }
  return results
}

/**
 * Найти запись каталога по URL-строке, как она лежит в `meta.proxy` аккаунта.
 * Сравниваем по host:port, а не по полной строке: URL мог прийти из импорта с другим
 * порядком/кодировкой логина, и точное сравнение молча не находило бы прокси.
 * @param {string} url
 */
export async function findProxyByUrl(url) {
  const raw = String(url || '').trim()
  if (!raw || raw === '—') return null
  let host = ''
  let port = ''
  try {
    const u = new URL(raw)
    host = u.hostname
    port = u.port
  } catch {
    const m = raw.replace(/^[a-z0-9]+:\/\//i, '').split('@').pop() || ''
    const parts = m.split(':')
    host = parts[0] || ''
    port = parts[1] || ''
  }
  if (!host || !port) return null
  const all = await listProxies()
  return all.find((p) => String(p.host) === host && String(p.port) === String(port)) || null
}

/**
 * Пометить прокси каталога по URL аккаунта (например `dead`) — чтобы сдохший прокси
 * сразу попадал в «нерабочие», а не ждал получасовой авто-проверки.
 * @param {string} url @param {'ok'|'bad'|'dead'|'unknown'} status
 */
export async function markProxyStatusByUrl(url, status) {
  if (!PROXY_STATUSES.includes(status)) return null
  const p = await findProxyByUrl(url)
  if (!p || p.status === status) return p
  try { return await updateProxy(p.id, { status, lastCheckAt: Date.now() }) } catch { return null }
}

/**
 * Карта использования прокси аккаунтами (§6: «1 прокси = 1 аккаунт»).
 * @param {Record<string, {proxy?: string}>} accountsMeta карта meta по accountId
 * @returns {Record<string, string[]>} proxyUrl → [accountId] (только реально назначенные)
 */
export function proxyUsageMap(accountsMeta = {}) {
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [accountId, meta] of Object.entries(accountsMeta)) {
    const url = meta?.proxy
    if (!url || url === '—') continue
    ;(out[url] = out[url] || []).push(accountId)
  }
  return out
}

/** Список прокси, назначенных более чем одному аккаунту (нарушение 1:1). */
export function sharedProxies(accountsMeta = {}) {
  return Object.entries(proxyUsageMap(accountsMeta))
    .filter(([, ids]) => ids.length > 1)
    .map(([url, ids]) => ({ url, accountIds: ids }))
}
