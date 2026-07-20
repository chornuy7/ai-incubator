/**
 * §4: файлы базы знаний цели — «база знаний с файлами, не только текст».
 * Файлы приходят data-URL'ом в JSON (без multipart-зависимостей), кладутся в
 * data/kb-files/ под безопасным именем; в KB-элементе хранится только fileRef.
 */
import crypto from 'crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dataPath } from './lib/jsonStore.js'

const KB_DIR = process.env.KB_FILES_DIR || dataPath('kb-files')

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

/** Ссылка на файл валидна (без обхода каталога). Чистая. */
export function isValidRef(ref) {
  return /^kbf_[a-z0-9]{8,}(\.[a-z0-9]{1,8})?$/i.test(String(ref || ''))
}

const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'text/markdown': '.md',
}

/** Сохранить файл КБ на диск. @returns {Promise<{ref,kind,mime,size,name}>} */
export async function saveKbFile(name, dataUrl) {
  const { mime, buffer } = parseDataUrl(dataUrl)
  await fs.mkdir(KB_DIR, { recursive: true })
  const ref = `kbf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}${EXT_BY_MIME[mime] || ''}`
  await fs.writeFile(path.join(KB_DIR, ref), buffer)
  return { ref, kind: kindFromMime(mime), mime, size: buffer.length, name: safeFileName(name) }
}

/** Прочитать файл КБ по ссылке. @returns {Promise<Buffer|null>} */
export async function readKbFile(ref) {
  if (!isValidRef(ref)) return null
  try { return await fs.readFile(path.join(KB_DIR, ref)) } catch { return null }
}

/** Удалить файл КБ (не критично, если его уже нет). */
export async function deleteKbFile(ref) {
  if (!isValidRef(ref)) return false
  try { await fs.unlink(path.join(KB_DIR, ref)); return true } catch { return false }
}
