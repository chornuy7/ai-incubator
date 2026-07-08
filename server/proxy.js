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
    return null
  }
}

/** @param {ReturnType<typeof parseProxy>} proxy */
export function clientOptions(proxy) {
  /** @type {Record<string, unknown>} */
  const opts = {
    connectionRetries: 5,
    useWSS: false,
  }
  if (proxy) opts.proxy = proxy
  return opts
}
