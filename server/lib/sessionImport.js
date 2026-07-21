/**
 * §2: конвертация чужих форматов Telegram-сессий в наш (GramJS StringSession).
 *
 * Аккаунт в системе — это файл `server/data/sessions/<accountId>.session` со строкой
 * StringSession (`1AgAO…`). Всё, что умеет этот модуль, сводится к одному: получить такую
 * строку из того, что человек скачал/купил, — папки tdata от Telegram Desktop или файла
 * `.session` от Telethon/Pyrogram.
 *
 * Форматы и как они распознаются:
 *  - **tdata** — папка Telegram Desktop (внутри `key_datas` + `D877F783D5D3EF8C`).
 *    Может быть под локальным паролем (passcode) и содержать НЕСКОЛЬКО аккаунтов.
 *  - **Telethon `.session`** — SQLite-файл с таблицей `sessions` (dc_id/server_address/port/auth_key).
 *    ВНИМАНИЕ: расширение совпадает с нашим, но формат другой — наш это текст, тот бинарь.
 *  - **Pyrogram `.session`** — бывает и SQLite, и текстовой строкой (base64).
 *  - **Готовая строка** — GramJS/Telethon/Pyrogram string session в текстовом файле.
 *
 * SQLite читаем через sql.js (WASM): на сервере Node 20, где `node:sqlite` ещё нет,
 * нативные биндинги ставить не хочется — WASM работает везде одинаково.
 */
import fs from 'fs/promises'
import path from 'path'
import {
  convertFromTdata,
  convertToGramjsSession,
  convertFromTelethonSession,
  convertFromPyrogramSession,
  parseGramjsSession,
  Tdata,
} from '@mtcute/convert'

/** Файл-маркер внутри tdata: без него это не tdata, а просто папка. */
const TDATA_MARKER = 'key_datas'

/** sql.js грузится лениво — WASM тянуть на каждый старт сервера незачем. */
let sqlPromise = null
function getSql() {
  if (!sqlPromise) sqlPromise = import('sql.js').then((m) => (m.default || m)())
  return sqlPromise
}

/** Ошибка импорта с человекочитаемой причиной (её показываем в отчёте построчно). */
export class ImportError extends Error {
  constructor(message, code = 'import_failed') {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

const exists = async (p) => { try { await fs.access(p); return true } catch { return false } }

/** Похожа ли папка на tdata (сама или через вложенную `tdata/`). @returns {Promise<string|null>} путь к tdata */
export async function resolveTdataDir(dir) {
  if (await exists(path.join(dir, TDATA_MARKER))) return dir
  const nested = path.join(dir, 'tdata')
  if (await exists(path.join(nested, TDATA_MARKER))) return nested
  return null
}

/**
 * Прочитать таблицу `sessions` из SQLite-файла Telethon/Pyrogram.
 * @param {Buffer} buf содержимое файла
 * @returns {{ dcId:number, ip:string, port:number, authKey:Uint8Array }|null}
 */
async function readSqliteSession(buf) {
  const SQL = await getSql()
  let db
  try {
    db = new SQL.Database(new Uint8Array(buf))
  } catch {
    return null
  }
  try {
    // Telethon: sessions(dc_id, server_address, port, auth_key). Pyrogram: sessions(dc_id, …, auth_key).
    const res = db.exec('SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1')
    const row = res?.[0]?.values?.[0]
    if (!row) return null
    const [dcId, ip, port, authKey] = row
    if (!authKey || authKey.length < 256) return null
    return { dcId: Number(dcId), ip: String(ip || ''), port: Number(port) || 443, authKey: new Uint8Array(authKey) }
  } catch {
    // У Pyrogram другая схема — пробуем её отдельно, без server_address.
    try {
      const res = db.exec('SELECT dc_id, auth_key FROM sessions LIMIT 1')
      const row = res?.[0]?.values?.[0]
      if (!row) return null
      const [dcId, authKey] = row
      if (!authKey || authKey.length < 256) return null
      return { dcId: Number(dcId), ip: '', port: 443, authKey: new Uint8Array(authKey) }
    } catch { return null }
  } finally {
    try { db?.close() } catch { /* нечего закрывать */ }
  }
}

/** SQLite всегда начинается с этой сигнатуры — дешёвая проверка до разбора. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')
export const isSqlite = (buf) => Buffer.isBuffer(buf) && buf.length > 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC)

/**
 * Готовая строка-сессия → StringSessionData. Пробуем все три диалекта:
 * наш GramJS-формат первым (чаще всего это реимпорт нашего же экспорта).
 * @param {string} text
 */
function fromSessionString(text) {
  const s = String(text || '').trim()
  if (!s || /\s/.test(s)) throw new ImportError('Файл не похож на строку-сессию')
  for (const [name, fn] of [['GramJS', parseGramjsSession], ['Telethon', convertFromTelethonSession], ['Pyrogram', convertFromPyrogramSession]]) {
    try {
      const out = fn(s)
      // parseGramjsSession отдаёт «сырой» разбор — приводим к StringSessionData через конвертер.
      return name === 'GramJS' ? convertFromTelethonSession(out) : out
    } catch { /* пробуем следующий диалект */ }
  }
  throw new ImportError('Строка не распознана ни как GramJS, ни как Telethon, ни как Pyrogram')
}

/**
 * Собрать StringSessionData из данных SQLite-сессии.
 * IP может отсутствовать (Pyrogram) — тогда берём боевой адрес DC по номеру.
 */
function fromSqliteRow(row) {
  return convertFromTelethonSession({
    dcId: row.dcId,
    ipAddress: row.ip || undefined,
    port: row.port,
    authKey: row.authKey,
  })
}

/**
 * Главная точка: превратить найденный источник в GramJS StringSession.
 * @param {{ kind:'tdata'|'session-file', path:string, accountIdx?:number, passcode?:string }} src
 * @returns {Promise<{ session:string, self:{ userId?:number, isBot?:boolean }|null }>}
 */
export async function toGramjsSession(src) {
  let data
  if (src.kind === 'tdata') {
    const open = (ignoreVersion) => convertFromTdata(
      { path: src.path, passcode: src.passcode || undefined, ignoreVersion },
      src.accountIdx || 0,
    )
    try {
      data = await open(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/passcode|decrypt/i.test(msg)) throw new ImportError('tdata под локальным паролем — укажите passcode', 'passcode_required')
      // Свежий Telegram Desktop пишет TDF новее, чем знает библиотека («Unsupported version: 70»).
      // Раскладка при этом та же, поэтому вторым заходом читаем, игнорируя номер версии.
      // Такое встречается, если папку хоть раз открывали самим Telegram Desktop.
      if (!/unsupported version/i.test(msg)) throw new ImportError(`tdata не читается: ${msg}`)
      try {
        data = await open(true)
      } catch (e2) {
        throw new ImportError(`tdata не читается даже без проверки версии: ${e2 instanceof Error ? e2.message : e2}`)
      }
    }
  } else {
    const buf = await fs.readFile(src.path)
    if (isSqlite(buf)) {
      const row = await readSqliteSession(buf)
      if (!row) throw new ImportError('SQLite-файл без таблицы sessions или без auth_key')
      data = fromSqliteRow(row)
    } else {
      data = fromSessionString(buf.toString('utf8'))
    }
  }
  const session = convertToGramjsSession(data)
  const self = data.self ? { userId: Number(data.self.userId) || undefined, isBot: !!data.self.isBot } : null
  return { session, self }
}

/**
 * Индексы аккаунтов внутри одной папки tdata: Telegram Desktop держит в профиле до 6 штук,
 * их порядок лежит в `keyData.order`. Ошибку не бросаем — если открыть не вышло (пароль,
 * незнакомая версия), считаем что аккаунт один, а настоящую причину покажет сам импорт.
 * @param {string} dir @param {string} [passcode] @returns {Promise<number[]>}
 */
export async function tdataAccountIndexes(dir, passcode) {
  for (const ignoreVersion of [false, true]) {
    try {
      const td = await Tdata.open({ path: dir, passcode: passcode || undefined, ignoreVersion })
      const order = td.keyData?.order
      if (Array.isArray(order) && order.length) return order.map(Number)
    } catch { /* пароль/версия — вторым заходом без проверки версии, дальше решает импорт */ }
  }
  return [0]
}
