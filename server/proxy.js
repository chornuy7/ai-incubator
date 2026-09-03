import { parseProxyLine } from './lib/proxyImport.js'

/** @param {string | undefined} raw */
export function parseProxy(raw) {
  if (!raw || raw.trim() === '' || raw === '—') return null
  const url = raw.trim()

  try {
    const u = new URL(url)
    const proto = u.protocol.replace(':', '').toLowerCase()
    if (proto !== 'socks5' && proto !== 'socks4' && proto !== 'http') return null

    const port = Number(u.port)
    if (!port) return null

    const proxy = {
      ip: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    }

    if (proto === 'socks5' || proto === 'socks4') {
      return { ...proxy, socksType: proto === 'socks5' ? 5 : 4 }
    }
    return proxy
  } catch {
    // MR-129: не URL — значит формат host:port[:user:pass] (как у продавцов и в импорте).
    // Раньше parseProxy понимал ТОЛЬКО URL, поэтому такой прокси считался «не настроен»:
    // раздел «Прокси» показывал пусто, а GramJS МОЛЧА шёл напрямую (аккаунт без прокси,
    // риск бана). Тот же разбор, что при импорте прокси (server/lib/proxyImport.js).
    const line = parseProxyLine(url)
    if (!line) return null
    const proxy = {
      ip: line.host,
      port: line.port,
      username: line.username || undefined,
      password: line.password || undefined,
    }
    if (line.scheme === 'socks5' || line.scheme === 'socks4') {
      return { ...proxy, socksType: line.scheme === 'socks5' ? 5 : 4 }
    }
    return proxy
  }
}

/** @param {ReturnType<typeof parseProxy>} proxy */
export function clientOptions(proxy) {
  /** @type {Record<string, unknown>} */
  const opts = {
    // Меньше ретраев = битый/мёртвый прокси падает быстрее, и воркер быстрее
    // возвращается к точке проверки «Стоп». Полный лимит по времени всё равно
    // держит connectWithTimeout (TG_CONNECT_TIMEOUT_MS). Было 5 — стоп на битом
    // прокси игнорировался десятками секунд, пока шли повторные попытки коннекта.
    connectionRetries: 2,
    useWSS: false,
  }
  if (proxy) opts.proxy = proxy
  return opts
}
