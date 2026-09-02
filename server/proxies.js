/**
 * Сущность «Прокси» (§3.2/3.4). Каталог прокси для привязки к аккаунтам.
 * Модель поддерживает решение заказчика (14.07): своя ферма + докупаемые (static/mobile).
 * Аккаунт ссылается на прокси идентификатором (`accounts_meta.proxy_id`), а строку
 * подключения для GramJS собирает `toProxyUrl` В МОМЕНТ КОННЕКТА. Хранить собранную
 * строку рядом со ссылкой нельзя: так уже было, и связь потерялась — см. MR-290.
 *
 * Хранение — таблица `proxies`; файл `data/proxies.json` остаётся только для тестов и
 * локального запуска (путь через env PROXIES_FILE).
 */
import crypto from 'crypto'
import net from 'net'
import { SocksClient } from 'socks'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled, isMissingTable } from './lib/supabase.js'
import { decryptSecret, secretForStorage } from './lib/secretBox.js'

const PROXIES_FILE = process.env.PROXIES_FILE || dataPath('proxies.json')

/*
 * MR-290 (вбирает MR-262): каталог прокси переехал в таблицу `proxies`.
 *
 * Таблицу завела MR-262 и залила данными (101 строка), но кода к ней не написала — стор
 * продолжал читать и писать `server/data/proxies.json`. Файл здесь особенно вреден: в нём
 * лежат ЛОГИНЫ И ПАРОЛИ прокси открытым текстом, и на втором инстансе каталог просто
 * разъезжается.
 *
 * Два правила, которые здесь соблюдаются:
 *
 *   1. ПАРОЛЬ НЕ ПОКИДАЕТ СЕРВЕР. `listProxies` отдаёт `hasPassword`, а не сам пароль:
 *      каталог уезжает в браузер, и до сих пор уезжал вместе с паролями — фронт собирал
 *      из них URL прокси (src/api/proxiesApi.ts). Пароль нужен ровно в одном месте — при
 *      сборке строки подключения на сервере, и для этого есть `proxyUrlById`.
 *   2. В базе пароль лежит шифрованным (`password_enc`, тот же механизм, что у облачных
 *      паролей и сессий). Колонка `password` остаётся до следующего релиза как запасной
 *      путь: перешифровку делает server/scripts/encrypt-proxy-passwords.mjs.
 */
const TABLE = 'proxies'
function sbP() { return supabaseEnabled() ? getSupabase() : null }

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null)
const msOf = (v) => (v ? new Date(v).getTime() : null)

/** Доменный объект → строка таблицы. Пароль уезжает только в шифрованном виде. */
const proxyToRow = (p) => ({
  id: p.id,
  label: p.label || '',
  kind: p.kind, scheme: p.scheme, host: p.host, port: p.port,
  username: p.username || null,
  password_enc: secretForStorage(p.password, true),
  country: p.country || null,
  geo_source: p.geoSource || null,
  rotate_url: p.rotateUrl || null,
  status: p.status || 'unknown',
  reason: p.reason || null,
  note: p.note || null,
  user_id: p.ownerId || null,
  last_check_at: iso(p.lastCheckAt),
  created_at: iso(p.createdAt) || new Date().toISOString(),
  updated_at: iso(p.updatedAt) || new Date().toISOString(),
})

/**
 * Строка таблицы → доменный объект.
 * @param {object} r @param {boolean} withSecret отдавать ли расшифрованный пароль
 */
function proxyFromRow(r, withSecret) {
  // Пока скрипт перешифровки не прошёл, значение может лежать ещё в `password`.
  const stored = r.password_enc ?? r.password ?? null
  return {
    id: r.id, label: r.label || '', kind: r.kind, scheme: r.scheme,
    host: r.host, port: r.port, username: r.username || '',
    ...(withSecret ? { password: decryptSecret(stored) || '' } : { hasPassword: !!stored }),
    country: r.country || '', geoSource: r.geo_source || null, rotateUrl: r.rotate_url || '',
    status: r.status || 'unknown', reason: r.reason || '', note: r.note || '',
    ownerId: r.user_id || undefined,
    lastCheckAt: msOf(r.last_check_at), createdAt: msOf(r.created_at), updatedAt: msOf(r.updated_at),
  }
}

/** Прочитать каталог. `withSecret` — только для серверных нужд (сборка URL, проверка живости). */
async function readProxies(withSecret) {
  const db = sbP()
  if (!db) {
    const arr = await readJson(PROXIES_FILE, [])
    const list = Array.isArray(arr) ? arr : []
    return withSecret ? list : list.map(({ password: _p, ...rest }) => ({ ...rest, hasPassword: !!_p }))
  }
  const { data, error } = await db.from(TABLE).select('*').order('created_at', { ascending: false })
  if (error) {
    if (!isMissingTable(error)) throw new Error(`[${TABLE}] чтение каталога прокси не удалось: ${error.message}`)
    const arr = await readJson(PROXIES_FILE, [])
    const list = Array.isArray(arr) ? arr : []
    return withSecret ? list : list.map(({ password: _p, ...rest }) => ({ ...rest, hasPassword: !!_p }))
  }
  return (data || []).map((r) => proxyFromRow(r, withSecret))
}

export const PROXY_KINDS = ['static', 'mobile', 'farm'] // статический / мобильный / своя ферма
export const PROXY_SCHEMES = ['socks5', 'http']
/**
 * `bad` — порт открыт, но выйти наружу через прокси не удалось: чаще всего это
 * неверная схема (socks5 вместо http). Раньше такой прокси показывался как `ok`,
 * потому что живость мерилась TCP-пингом, а порт открыт всегда (баг 2, 21.07).
 */
export const PROXY_STATUSES = ['ok', 'bad', 'dead', 'unknown']

/**
 * Годится ли прокси, чтобы ВЫДАВАТЬ его аккаунту.
 *
 * Отсеиваем и `dead` (хост молчит), и `bad` — в том числе «не пускает в Telegram»:
 * раньше проверялся только `dead`, поэтому полсотни прокси, которые ходят в интернет,
 * но не пускают в Telegram, спокойно раздавались аккаунтам (правка заказчика 12.08).
 * `unknown` оставляем: он ещё не проверялся, а не признан плохим.
 * @param {{status?: string}} p
 */
export function isUsableProxy(p) {
  return p?.status !== 'dead' && p?.status !== 'bad'
}

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

/** Каталог для интерфейса и API. БЕЗ паролей — только признак `hasPassword`. */
export async function listProxies() {
  return readProxies(false)
}

/** Каталог с паролями. Только для серверных нужд: сборка URL, проверка живости. */
export async function listProxiesWithSecrets() {
  return readProxies(true)
}

/*
 * КЭША КАТАЛОГА ЗДЕСЬ БОЛЬШЕ НЕТ — и это осознанно.
 *
 * Он существовал ради одной привычки: строка подключения подклеивалась ко ВСЕЙ мете на
 * каждом её чтении, то есть каталог читался и расшифровывался постоянно, и без копии в
 * памяти это выходило невыносимо дорого. Копия лечила симптом.
 *
 * Причина убрана: строка подключения собирается по ссылке `proxyId` в момент коннекта —
 * это одна строка по первичному ключу. Кэшировать нечего, а копия ответа базы в памяти
 * процесса — это ещё один источник правды, который однажды разойдётся с базой.
 */

/** Одна запись каталога по идентификатору — БЕЗ пароля. Для показа и проверок статуса. */
export async function getProxy(id) {
  const key = String(id || '').trim()
  if (!key) return null
  const db = sbP()
  if (!db) return (await listProxies()).find((p) => p.id === key) || null
  const { data, error } = await db.from(TABLE).select('*').eq('id', key).maybeSingle()
  if (error && !isMissingTable(error)) throw new Error('[' + TABLE + '] прокси не прочитан: ' + error.message)
  return data ? proxyFromRow(data, false) : null
}

/** Одна запись каталога по идентификатору — С паролем. Только для сборки строки коннекта. */
export async function getProxyWithSecret(id) {
  const key = String(id || '').trim()
  if (!key) return null
  const db = sbP()
  if (!db) return (await listProxiesWithSecrets()).find((p) => p.id === key) || null
  const { data, error } = await db.from(TABLE).select('*').eq('id', key).maybeSingle()
  if (error && !isMissingTable(error)) throw new Error('[' + TABLE + '] прокси не прочитан: ' + error.message)
  return data ? proxyFromRow(data, true) : null
}

/**
 * Строка подключения для аккаунта: собирается из строки прокси В МОМЕНТ КОННЕКТА.
 *
 * Собранный URL нигде не хранится — именно из-за хранения связь один раз уже потерялась:
 * `accounts_meta.proxy` содержал строку, прокси меняли, строка оставалась прежней. Теперь
 * источник один — `accounts_meta.proxy_id`, а URL производный.
 * @param {string|null|undefined} proxyId @returns {Promise<string>} пустая строка — без прокси
 */
export async function proxyUrlById(proxyId) {
  const p = await getProxyWithSecret(proxyId)
  return p ? toProxyUrl(p) : ''
}

/**
 * Строка подключения ДЛЯ АККАУНТА — по ссылке в его мете.
 *
 * Единственный способ её получить. Раньше она лежала в `meta.proxy`, подклеенная к мете
 * при чтении, и любой читатель меты платил за весь каталог. Теперь её просят явно — и
 * там, где действительно подключаются.
 *
 * @param {{proxyId?: string|null}|null|undefined} meta
 * @returns {Promise<string>} пустая строка — прямое подключение
 */
export async function accountProxyUrl(meta) {
  if (!meta?.proxyId) return '' // прокси не назначен — прямое подключение, так и задумано
  const url = await proxyUrlById(meta.proxyId)
  /*
   * Ссылка есть, а записи нет — молчать нельзя.
   *
   * Пустая строка здесь означала бы «иди напрямую», то есть аккаунт вышел бы в Telegram
   * с адреса сервера. Со стороны это выглядит как обычная работа, а на деле — тот самый
   * способ потерять аккаунт, ради предотвращения которого прокси и заводят. Лучше явная
   * ошибка в логе задачи.
   */
  if (!url) throw new Error('Прокси ' + meta.proxyId + ' назначен аккаунту, но в каталоге его нет')
  return url
}

/** Сохранить каталог целиком — только для файлового режима (тесты, локальный запуск). */
async function writeProxiesFile(all) {
  await writeJson(PROXIES_FILE, all)
}

/**
 * Перенести каталог как есть, СОХРАНИВ идентификаторы (MR-262, вобрано в MR-290).
 *
 * Нужна ровно один раз — когда каталог переезжает из файла в базу (скрипт
 * `server/scripts/proxy-backfill.mjs`). `createProxy` тут не годится: он выдаёт НОВЫЙ id,
 * а на старые id уже ссылаются аккаунты — после такого переноса ссылки указывали бы в
 * пустоту, и полсотни аккаунтов пошли бы в Telegram напрямую с адреса сервера.
 *
 * Идемпотентна: запись с таким id или с такой же точкой входа пропускается. Повторный
 * прогон переноса — обычное дело, и задваивать каталог он не должен.
 *
 * @param {object[]} entries @returns {Promise<{added:number, skipped:number}>}
 */
export async function importProxies(entries = []) {
  const итог = { added: 0, skipped: 0 }
  const входные = Array.isArray(entries) ? entries.filter((e) => e && e.host && e.port) : []
  if (!входные.length) return итог

  // Точка входа — адрес, порт и ЛОГИН: у одного хоста бывает несколько записей с разными
  // логинами. Пароль в ключ не входит: сменили пароль — это та же самая точка входа.
  const ключ = (p) => `${p.host}:${p.port}:${p.username || ''}`
  const уже = await listProxiesWithSecrets()
  const поId = new Set(уже.map((p) => p.id))
  const поАдресу = new Set(уже.map(ключ))

  const добавить = []
  for (const e of входные) {
    if ((e.id && поId.has(e.id)) || поАдресу.has(ключ(normalizeProxy(e)))) { итог.skipped++; continue }
    const запись = {
      ...normalizeProxy(e),
      id: e.id || `px_${crypto.randomUUID().slice(0, 8)}`,
      ...(e.ownerId ? { ownerId: e.ownerId } : {}),
      lastCheckAt: e.lastCheckAt ?? null,
      createdAt: e.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    поId.add(запись.id)
    поАдресу.add(ключ(запись))
    добавить.push(запись)
  }
  if (!добавить.length) return итог

  const db = sbP()
  if (db) {
    // `ignoreDuplicates` вместо обновления: перенос НЕ должен трогать то, что уже в базе.
    // Уникальный индекс по точке входа при этом остаётся последним словом.
    const { error } = await db.from(TABLE).upsert(добавить.map(proxyToRow), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw new Error(`[${TABLE}] перенос каталога не удался: ${error.message}`)
    итог.added = добавить.length
    return итог
  }
  await writeProxiesFile([...добавить, ...уже])
  итог.added = добавить.length
  return итог
}

/** @param {object} input @throws при пустом host/port */
export async function createProxy(input) {
  const clean = normalizeProxy(input)
  if (!clean.host || !clean.port) throw new Error('Укажите host и port')
  const proxy = {
    id: `px_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    // Аудит 20.08: прокси — ресурс клиента (логин/пароль!), а каталог отдавался всем.
    // Пишем владельца пространства, чтобы на чтении отдавать только своё. normalizeProxy
    // владельца не знает, поэтому ставим его здесь, после clean.
    ownerId: String(input?.ownerId || '').trim() || undefined,
    lastCheckAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const db = sbP()
  if (db) {
    const { error } = await db.from(TABLE).insert(proxyToRow(proxy))
    if (error) {
      // MR-169: точку входа определяют адрес, порт и логин — за этим следит уникальный
      // индекс. Раньше проверка жила только в коде и делалась ДО вставки: между проверкой
      // и записью помещался второй такой же запрос, и дубль всё равно появлялся.
      if (/duplicate key|unique constraint/i.test(error.message)) {
        throw new Error('Такой прокси уже есть в каталоге (тот же адрес, порт и логин)')
      }
      throw new Error(`[${TABLE}] прокси не создан: ${error.message}`)
    }
    return { ...proxy, password: undefined, hasPassword: !!clean.password }
  }
  const all = await listProxiesWithSecrets()
  const dupe = all.find((p) => p.host === clean.host && p.port === clean.port
    && (p.username || '') === (clean.username || ''))
  if (dupe) throw new Error(`Такой прокси уже есть в каталоге${dupe.label ? ` («${dupe.label}»)` : ''}`)
  all.unshift(proxy)
  await writeProxiesFile(all)
  return proxy
}

/** @param {string} id @param {object} patch */
export async function updateProxy(id, patch = {}) {
  const all = await listProxiesWithSecrets()
  const i = all.findIndex((p) => p.id === id)
  if (i === -1) return null
  const clean = normalizeProxy({ ...all[i], ...patch })
  if (!clean.host || !clean.port) throw new Error('Host и port обязательны')
  const next = { ...all[i], ...clean, updatedAt: Date.now() }
  // normalizeProxy не знает про lastCheckAt — сохраняем его из патча явно (иначе теряется).
  if (patch.lastCheckAt !== undefined) next.lastCheckAt = patch.lastCheckAt
  if (patch.ownerId !== undefined) next.ownerId = String(patch.ownerId || '').trim() || undefined
  const db = sbP()
  if (db) {
    const { error } = await db.from(TABLE).update(proxyToRow(next)).eq('id', id)
    if (error) throw new Error(`[${TABLE}] прокси не обновлён: ${error.message}`)
    return { ...next, password: undefined, hasPassword: !!next.password }
  }
  all[i] = next
  await writeProxiesFile(all)
  return all[i]
}

export async function deleteProxy(id) {
  const db = sbP()
  if (db) {
    // Аккаунты, у которых он был назначен, освобождаются внешним ключом
    // (accounts_meta.proxy_id ... on delete set null) — отдельного прохода не нужно.
    const { data, error } = await db.from(TABLE).delete().eq('id', id).select('id')
    if (error) throw new Error(`[${TABLE}] прокси не удалён: ${error.message}`)
    return (data || []).length > 0
  }
  const all = await listProxiesWithSecrets()
  const next = all.filter((p) => p.id !== id)
  if (next.length === all.length) return false
  await writeProxiesFile(next)
  return true
}

/**
 * MR-170 (14.08): пакетное удаление за ОДНУ операцию.
 * Раньше UI слал N параллельных DELETE /:id — конкурентные read-modify-write одного JSON
 * теряли данные (last-write-wins), из-за чего «удалились все прокси». В базе это один
 * запрос, и проблема исчезает вместе с файлом.
 * @param {string[]} ids @returns {Promise<number>} сколько удалено
 */
export async function deleteProxies(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))]
  if (!list.length) return 0
  const db = sbP()
  if (db) {
    const { data, error } = await db.from(TABLE).delete().in('id', list).select('id')
    if (error) throw new Error(`[${TABLE}] прокси не удалены: ${error.message}`)
    return (data || []).length
  }
  const set = new Set(list)
  const all = await listProxiesWithSecrets()
  const next = all.filter((p) => !set.has(p.id))
  const removed = all.length - next.length
  if (removed > 0) await writeProxiesFile(next)
  return removed
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
  // Тоже с секретом: без пароля проба через прокси не пройдёт авторизацию.
  const p = (await listProxiesWithSecrets()).find((x) => x.id === id) || null
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
/**
 * Проверить живость прокси.
 * @param {string[]|null} [onlyIds] какие проверять. Роут передаёт сюда прокси автора
 * запроса: без этого один клиент прогонял и видел вердикт по всем прокси платформы —
 * то есть узнавал, сколько их у соседа и какие живые. `null` — плановая проверка, все.
 * @param {number} [timeoutMs]
 */
export async function checkAllProxies(onlyIds = null, timeoutMs = 9000) {
  const allow = onlyIds ? new Set(onlyIds.map(String)) : null
  // Пробе нужен пароль — берём каталог с секретами (наружу он всё равно не уходит).
  const all = (await listProxiesWithSecrets()).filter((p) => !allow || allow.has(String(p.id)))
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
  // Логин сравниваем, если он в строке есть: на одном host:port у продавца бывает
  // несколько учёток, и поиск только по адресу возвращал бы первую попавшуюся.
  let login = ''
  try { login = decodeURIComponent(new URL(raw).username || '') } catch { /* строка не URL */ }
  /*
   * Поиск по строке остался только для переноса старых записей и ручного ввода: свои
   * прокси аккаунт держит ссылкой, и по ней берётся одна строка (`getProxy`). В цикле по
   * аккаунтам эта функция больше не зовётся, поэтому чтение каталога здесь допустимо.
   */
  const all = await listProxies()
  const same = all.filter((p) => String(p.host) === host && String(p.port) === String(port))
  if (login) return same.find((p) => String(p.username || '') === login) || null
  return same[0] || null
}

/**
 * Найти прокси по строке подключения или завести его в каталоге. Возвращает идентификатор.
 *
 * Нужно там, где прокси приходит СТРОКОЙ извне: из json продавца рядом с сессией
 * («sidecar») или из формы импорта, где оператор вписал его руками. Раньше такая строка
 * оседала прямо в мете аккаунта, минуя каталог, — и получался прокси, которого нет в
 * списке, но который используется. Теперь любая строка сначала становится записью
 * каталога, а аккаунт ссылается на неё идентификатором.
 * @param {string} url @param {string} [ownerId]
 * @returns {Promise<string|null>} id прокси или null, если строку разобрать не удалось
 */
export async function ensureProxyByUrl(url, ownerId) {
  const raw = String(url || '').trim()
  if (!raw || raw === '—') return null
  const found = await findProxyByUrl(raw)
  if (found) return found.id
  let u
  try { u = new URL(raw) } catch { return null }
  const port = Number(u.port)
  if (!u.hostname || !port) return null
  const created = await createProxy({
    scheme: u.protocol.replace(':', ''),
    host: u.hostname,
    port,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    ownerId,
  })
  return created?.id || null
}

/**
 * Строка подключения для аккаунта. Сюда приходит уже прочитанная мета, чтобы не читать
 * каталог по разу на аккаунт: массовые операции идут пачками по десяткам аккаунтов.
 * @param {{proxyId?: string}} meta @param {{id:string, password?:string}[]} catalog
 */
export function proxyUrlFor(meta, catalog) {
  const id = String(meta?.proxyId || '').trim()
  if (!id) return ''
  const p = (catalog || []).find((x) => x.id === id)
  return p ? toProxyUrl(p) : ''
}

/**
 * Пометить прокси (например `dead`) — чтобы сдохший сразу попадал в «нерабочие», а не
 * ждал получасовой авто-проверки.
 *
 * MR-290: по идентификатору, а не по URL. Прежний `markProxyStatusByUrl` разбирал строку
 * подключения и искал прокси по host:port — то есть при совпадении адреса мог пометить
 * ЧУЖОЙ прокси, а при смене адреса не находил нужный вовсе.
 * @param {string} proxyId @param {'ok'|'bad'|'dead'|'unknown'} status
 */
export async function markProxyStatus(proxyId, status) {
  if (!PROXY_STATUSES.includes(status)) return null
  const id = String(proxyId || '').trim()
  if (!id) return null
  const p = await getProxy(id)
  if (!p || p.status === status) return p
  try { return await updateProxy(id, { status, lastCheckAt: Date.now() }) } catch { return null }
}

/**
 * УСТАРЕЛО (MR-290): поиск прокси по строке подключения.
 *
 * Оставлено на время переезда — вызывающие переходят на `markProxyStatus(proxyId)`.
 * @deprecated
 */
export async function markProxyStatusByUrl(url, status) {
  const p = await findProxyByUrl(url)
  return p ? markProxyStatus(p.id, status) : null
}

/**
 * Карта использования прокси аккаунтами (§6: «1 прокси = 1 аккаунт»).
 *
 * MR-290: ключ — ИДЕНТИФИКАТОР прокси, а не собранный URL. По URL счёт был неверным по
 * построению: строка собирается из логина и пароля, и смена пароля превращала один прокси
 * в два разных ключа. На боевой это и случилось — у всех аккаунтов строка подключения
 * оказалась пустой, и «занятость» показывала ноль при 55 назначенных прокси.
 * @param {Record<string, {proxyId?: string}>} accountsMeta карта meta по accountId
 * @returns {Record<string, string[]>} proxyId → [accountId]
 */
export function proxyUsageMap(accountsMeta = {}) {
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [accountId, meta] of Object.entries(accountsMeta)) {
    const id = meta?.proxyId
    if (!id) continue
    ;(out[id] = out[id] || []).push(accountId)
  }
  return out
}

/** Список прокси, назначенных более чем одному аккаунту (нарушение 1:1). */
export function sharedProxies(accountsMeta = {}) {
  return Object.entries(proxyUsageMap(accountsMeta))
    .filter(([, ids]) => ids.length > 1)
    .map(([proxyId, ids]) => ({ proxyId, accountIds: ids }))
}
