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
    status: PROXY_STATUSES.includes(input.status) ? input.status : 'unknown',
    // Откуда взялась страна: `exit` — реальный выходной IP, `gateway` — адрес шлюза
    // (у мобильных прокси это дата-центр провайдера, а не страна выхода — то есть «примерно»).
    geoSource: ['exit', 'gateway'].includes(input.geoSource) ? input.geoSource : null,
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
 * Проверить прокси по-настоящему: не «открыт ли порт», а «видно ли через него интернет».
 *
 * TCP-пинг оставлен как быстрая отсечка мёртвого хоста, но сам по себе он ничего не
 * доказывает — порт отвечает и когда мы говорим на нём не тем протоколом. Поэтому
 * решающая проба — выход наружу (`probeProxyExitGeo`). Она же даёт настоящую страну.
 *
 * @param {object} p запись прокси
 * @param {number} [timeoutMs]
 * @returns {Promise<{status:string, geo:object|null, geoSource:string|null}>}
 */
export async function probeProxy(p, timeoutMs = 9000) {
  const reachable = await tcpPing(p.host, p.port, Math.min(timeoutMs, 6000))
  if (!reachable) return { status: 'dead', geo: null, geoSource: null }

  const exit = await probeProxyExitGeo(p, timeoutMs)
  if (exit) return { status: 'ok', geo: exit, geoSource: 'exit' }

  // Порт открыт, а наружу не пускает. Страну берём по шлюзу — но помечаем её как
  // приблизительную, чтобы оператор не раздал «немецкий» прокси с польским выходом.
  const gateway = await probeProxyGeo(p.host, Math.min(timeoutMs, 6000))
  return { status: 'bad', geo: gateway, geoSource: gateway ? 'gateway' : null }
}

/** Проверить один прокси и записать статус + актуальные гео/geoSource. */
export async function checkProxyLiveness(id, timeoutMs = 9000) {
  const p = await getProxy(id)
  if (!p) return null
  const { status, geo, geoSource } = await probeProxy(p, timeoutMs)
  return updateProxy(id, {
    status,
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
  for (const p of all) {
    const { status, geo, geoSource } = await probeProxy(p, timeoutMs)
    try {
      await updateProxy(p.id, {
        status,
        lastCheckAt: Date.now(),
        ...(geo ? { country: geo.country || p.country, geoSource, note: geoNote(geo) } : {}),
      })
    } catch { /* skip */ }
    results.push({ id: p.id, status, country: geo?.country || p.country || '', geoSource })
  }
  return results
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
