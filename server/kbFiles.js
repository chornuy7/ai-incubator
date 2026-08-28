/**
 * §4: файлы базы знаний цели — «база знаний с файлами, не только текст».
 * Файлы приходят data-URL'ом в JSON (без multipart-зависимостей); в KB-элементе
 * хранится только `fileRef`.
 *
 * С 27.08 (MR-186) содержимое лежит в ОБЩЕЙ БАЗЕ (`kb_files`). До этого файлы падали в
 * каталог data/kb-files/ рядом с сервером — то есть на диск ОДНОГО инстанса. Для второго
 * сервера такого файла просто не существует: запись базы знаний есть, ссылка есть,
 * а вложение не открывается. Пропал диск — вложения не восстановить.
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dataPath } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

/** Путь считаем лениво — по той же причине, что и у остальных сторов (см. goals.js). */
const kbDir = () => process.env.KB_FILES_DIR || dataPath('kb-files')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Таблицы ещё нет (миграция не накатана) — ведём себя как «файла нет», а не падаем. */
const isMissingTable = (error) =>
  !!error && /kb_files|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

/** Лимит на файл (тело запроса 5mb, base64 раздувает ~на треть). */
export const KB_FILE_MAX_BYTES = 3 * 1024 * 1024

/** Разрешённые типы: документы и картинки. Исполняемое не принимаем. */
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

/** Недопустимые в имени файла символы. */
const BAD_NAME_CHARS = '<>:"|?*'

/**
 * Разобрать data-URL. Чистая функция.
 * @param {string} dataUrl @returns {{mime: string, buffer: Buffer}}
 * @throws если формат не data-URL, тип запрещён или размер превышен
 */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) throw new Error('Ожидается файл в формате data:<mime>;base64,<данные>')
  const mime = m[1].toLowerCase()
  if (!ALLOWED_MIME.has(mime)) throw new Error(`Тип файла не поддерживается: ${mime}`)
  const buffer = Buffer.from(m[2], 'base64')
  if (!buffer.length) throw new Error('Пустой файл')
  if (buffer.length > KB_FILE_MAX_BYTES) {
    throw new Error(`Файл больше ${Math.round(KB_FILE_MAX_BYTES / 1024 / 1024)} МБ — уменьшите или приложите ссылкой`)
  }
  return { mime, buffer }
}

/** Картинка это или обычный файл (для kind в KB). Чистая. */
export function kindFromMime(mime) {
  return String(mime || '').startsWith('image/') ? 'image' : 'file'
}

/**
 * Безопасное имя файла для показа: без путей, спецсимволов и управляющих кодов.
 * Пробелы и кириллица сохраняются. Чистая функция.
 * @param {string} name
 */
export function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file'
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 32 && !BAD_NAME_CHARS.includes(ch))
    .join('')
  return cleaned.trim().slice(0, 120) || 'file'
}

/**
 * Ссылка на файл валидна. Чистая.
 *
 * Проверка осталась и после переезда в базу: раньше она защищала от обхода каталога,
 * теперь — не пускает в запрос произвольную строку из тела запроса. Формат ссылки
 * задаём мы сами, всё остальное — не наш файл.
 */
export function isValidRef(ref) {
  return /^kbf_[a-z0-9]{8,}(\.[a-z0-9]{1,8})?$/i.test(String(ref || ''))
}

const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'text/markdown': '.md',
}

/**
 * bytea через REST ходит шестнадцатеричной строкой с префиксом `\x` — это формат самого
 * Postgres (`bytea_output = hex`), а не наша выдумка. Base64 в текстовой колонке был бы
 * проще, но это притворяться текстом ради удобства и платить третью объёма.
 */
const toBytea = (buffer) => `\\x${buffer.toString('hex')}`
const fromBytea = (value) => {
  if (value == null) return null
  if (Buffer.isBuffer(value)) return value
  const s = String(value)
  return s.startsWith('\\x') ? Buffer.from(s.slice(2), 'hex') : Buffer.from(s, 'base64')
}

/** Сохранить файл КБ. @returns {Promise<{ref,kind,mime,size,name}>} */
export async function saveKbFile(name, dataUrl) {
  const { mime, buffer } = parseDataUrl(dataUrl)
  const ref = `kbf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}${EXT_BY_MIME[mime] || ''}`
  const meta = { ref, kind: kindFromMime(mime), mime, size: buffer.length, name: safeFileName(name) }

  const db = sb()
  if (db) {
    const { error } = await db.from('kb_files').insert({
      id: ref, name: meta.name, mime, size_bytes: buffer.length, data: toBytea(buffer), created_at: Date.now(),
    })
    if (error) {
      if (isMissingTable(error)) throw new Error('Вложения временно недоступны: не применена миграция базы')
      throw new Error(`Не удалось сохранить файл: ${error.message}`)
    }
    return meta
  }
  const dir = kbDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, ref), buffer)
  return meta
}

/** Прочитать файл КБ по ссылке. @returns {Promise<Buffer|null>} */
export async function readKbFile(ref) {
  if (!isValidRef(ref)) return null
  const db = sb()
  if (db) {
    const { data, error } = await db.from('kb_files').select('data').eq('id', ref).limit(1)
    if (error || !data?.length) return null
    return fromBytea(data[0].data)
  }
  try { return await fs.readFile(path.join(kbDir(), ref)) } catch { return null }
}

/** Удалить файл КБ (не критично, если его уже нет). */
export async function deleteKbFile(ref) {
  if (!isValidRef(ref)) return false
  const db = sb()
  if (db) {
    const { data, error } = await db.from('kb_files').delete().eq('id', ref).select('id')
    if (error) return false
    return (data || []).length > 0
  }
  try { await fs.unlink(path.join(kbDir(), ref)); return true } catch { return false }
}
