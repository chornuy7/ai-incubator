import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Корневая папка для всех общих JSON-хранилищ фич (папки целей, ИИ-настройки, ЧС и т.д.). */
export const DATA_DIR = path.join(__dirname, '..', 'data')

/** @param {string} relPath относительный путь внутри server/data */
export function dataPath(relPath) {
  return path.join(DATA_DIR, relPath)
}

/**
 * Прочитать JSON-файл с дефолтом. Безопасно возвращает fallback, если файла нет/битый.
 * @template T
 * @param {string} file абсолютный путь
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Атомарно записать JSON-файл (через временный файл + rename).
 * @param {string} file абсолютный путь
 * @param {unknown} value
 */
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}
