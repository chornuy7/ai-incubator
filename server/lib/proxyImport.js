/**
 * §3.2: массовый импорт прокси. Продавцы отдают списки в десятке разных форматов,
 * поэтому парсер намеренно всеядный, а неразобранные строки не теряются — они уходят
 * в отчёт с причиной, чтобы человек увидел, что именно не поехало.
 *
 * Здесь только чистые функции (парсинг + именование) — сеть и запись в хранилище живут
 * в роуте. Так это тестируется без прокси и без интернета.
 */

/** Схемы, которые понимает GramJS (server/proxy.js#parseProxy). */
const SCHEMES = ['socks5', 'socks4', 'http', 'https']

const isPort = (s) => /^\d{1,5}$/.test(String(s)) && Number(s) > 0 && Number(s) <= 65535
/** Хост — это IPv4 или домен. Логин/пароль такими обычно не бывают. */
const isHost = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s)) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s))

/**
 * Разобрать одну строку прокси. Поддержаны форматы:
 *   host:port
 *   host:port:user:pass
 *   user:pass:host:port
 *   user:pass@host:port
 *   host:port@user:pass
 *   scheme://любой из вышеперечисленных
 * Разделители полей — `:`; строку можно писать через пробел/таб/`;` — их нормализуем заранее.
 *
 * @param {string} raw
 * @param {{scheme?: string}} [defaults]
 * @returns {{scheme:string, host:string, port:number, username:string, password:string}|null}
 */
export function parseProxyLine(raw, defaults = {}) {
  let s = String(raw || '').trim()
  if (!s || s.startsWith('#') || s.startsWith('//')) return null

  // Табы/точки с запятой/пробелы между полями — приводим к двоеточию.
  s = s.replace(/[\t;,\s]+/g, ':').replace(/:{2,}/g, ':').replace(/^:|:$/g, '')

  let scheme = SCHEMES.includes(defaults.scheme) ? defaults.scheme : 'socks5'
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i)
  if (m) {
    const found = m[1].toLowerCase()
    if (!SCHEMES.includes(found)) return null
    scheme = found === 'https' ? 'http' : found // https-прокси ходят тем же CONNECT, что http
    s = m[2]
  }
  if (!s) return null

  let username = ''
  let password = ''

  // Форма с «собакой»: одна половина — адрес, другая — учётка. Какая где, решаем по виду.
  if (s.includes('@')) {
    const at = s.lastIndexOf('@')
    const left = s.slice(0, at)
    const right = s.slice(at + 1)
    const rightParts = right.split(':')
    const leftParts = left.split(':')
    const rightIsAddr = rightParts.length >= 2 && isPort(rightParts[1]) && isHost(rightParts[0])
    const addr = rightIsAddr ? rightParts : leftParts
    const cred = rightIsAddr ? leftParts : rightParts
    if (!(addr.length >= 2 && isPort(addr[1]) && isHost(addr[0]))) return null
    username = cred[0] || ''
    password = cred.slice(1).join(':') || ''
    return { scheme, host: addr[0], port: Number(addr[1]), username, password }
  }

  const p = s.split(':')
  if (p.length === 2) {
    if (!isHost(p[0]) || !isPort(p[1])) return null
    return { scheme, host: p[0], port: Number(p[1]), username: '', password: '' }
  }
  if (p.length >= 4) {
    // host:port:user:pass — самый частый у продавцов.
    if (isHost(p[0]) && isPort(p[1])) {
      return { scheme, host: p[0], port: Number(p[1]), username: p[2] || '', password: p.slice(3).join(':') }
    }
    // user:pass:host:port — встречается реже, но встречается.
    if (isHost(p[2]) && isPort(p[3])) {
      return { scheme, host: p[2], port: Number(p[3]), username: p[0] || '', password: p[1] || '' }
    }
  }
  return null
}

/**
 * Разобрать список: по строке на прокси. Дубли внутри самого списка схлопываем.
 * @param {string} text @param {{scheme?: string}} [defaults]
 * @returns {{ items: object[], errors: {line:number, raw:string, reason:string}[] }}
 */
export function parseProxyList(text, defaults = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const items = []
  const errors = []
  const seen = new Set()
  lines.forEach((raw, i) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return
    const parsed = parseProxyLine(trimmed, defaults)
    if (!parsed) {
      errors.push({ line: i + 1, raw: trimmed, reason: 'не удалось разобрать формат' })
      return
    }
    const key = proxyKey(parsed)
    if (seen.has(key)) {
      errors.push({ line: i + 1, raw: trimmed, reason: 'дубль внутри списка' })
      return
    }
    seen.add(key)
    items.push({ ...parsed, raw: trimmed })
  })
  return { items, errors }
}

/** Ключ для дедупликации: адрес + учётка (один хост может продаваться с разными логинами). */
export const proxyKey = (p) => `${p.scheme}://${p.username}:${p.password}@${p.host}:${p.port}`.toLowerCase()

/**
 * Как назвать страну в имени прокси. ip-api отдаёт ISO-код (`us`), а в обиходе
 * пишут «USA»/«UK» — держим короткий словарь исключений, остальное просто в верхнем регистре.
 */
const COUNTRY_ALIASES = { us: 'USA', gb: 'UK', ae: 'UAE', kr: 'KR', cz: 'CZ' }
/** @param {string} code ISO-код страны (us/de/ua) @param {string} [fallback] */
export function countryLabel(code, fallback = '') {
  const c = String(code || '').trim().toLowerCase()
  if (!c) return String(fallback || 'XX').toUpperCase()
  return COUNTRY_ALIASES[c] || c.toUpperCase()
}

/**
 * Собрать имя по шаблону. Плейсхолдеры: {country} {tag} {n} {host} {port}.
 * Пустые куски и лишние пробелы схлопываются — «USA  1» не появится.
 * @param {string} template @param {{country?:string, tag?:string, n?:number, host?:string, port?:number}} vars
 */
export function buildLabel(template, vars = {}) {
  const t = String(template || '{country} {tag} {n}')
  return t
    .replace(/\{country\}/gi, vars.country ?? '')
    .replace(/\{tag\}/gi, vars.tag ?? '')
    .replace(/\{n\}/gi, vars.n == null ? '' : String(vars.n))
    .replace(/\{host\}/gi, vars.host ?? '')
    .replace(/\{port\}/gi, vars.port == null ? '' : String(vars.port))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * С какого номера продолжать нумерацию. Если в базе уже есть «USA SPAM 1..5»,
 * то новые пять должны стать 6..10, а не переписать существующие имена.
 * @param {string[]} existingLabels @param {string} prefix напр. «USA SPAM»
 * @returns {number} следующий свободный номер (минимум 1)
 */
export function nextIndexFor(existingLabels, prefix) {
  const p = String(prefix || '').trim().toLowerCase()
  if (!p) return 1
  let max = 0
  for (const l of existingLabels || []) {
    const s = String(l || '').trim().toLowerCase()
    if (!s.startsWith(p)) continue
    const tail = s.slice(p.length).trim()
    const n = Number(tail)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}

/**
 * Присвоить имена пачке: нумерация идёт ОТДЕЛЬНО по каждой стране, поэтому
 * «USA SPAM 1,2,3» и «DE SPAM 1,2» живут в одном импорте не конфликтуя.
 * @param {{country?:string, host?:string, port?:number}[]} items прокси с уже определённой страной
 * @param {{template?:string, tag?:string, existingLabels?:string[]}} opts
 * @returns {string[]} имена в том же порядке, что items
 */
export function assignLabels(items, opts = {}) {
  const template = opts.template || '{country} {tag} {n}'
  const tag = opts.tag || ''
  const existing = opts.existingLabels || []
  /** @type {Record<string, number>} счётчик по стране */
  const counters = {}
  return (items || []).map((it) => {
    const country = countryLabel(it.country, it.countryFallback)
    const prefix = buildLabel(template.replace(/\{n\}/gi, ''), { country, tag, host: it.host, port: it.port })
    if (counters[prefix] == null) counters[prefix] = nextIndexFor(existing, prefix)
    const n = counters[prefix]++
    return buildLabel(template, { country, tag, n, host: it.host, port: it.port })
  })
}
