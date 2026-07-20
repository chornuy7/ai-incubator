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

// Очередь операций на каждый файл — сериализует read-modify-write, чтобы два
// параллельных изменения не затирали друг друга (потерянное обновление).
const _fileChains = new Map()

/**
 * Безопасный read-modify-write одного файла (в рамках процесса). Мутатор получает
 * текущее значение и возвращает новое; если вернул undefined — запись пропускается.
 * Операции над ОДНИМ файлом выполняются строго по очереди.
 * @template T
 * @param {string} file абсолютный путь
 * @param {(current: T) => T | undefined | Promise<T | undefined>} mutator
 * @param {T} fallback значение, если файла нет
 * @returns {Promise<T | undefined>}
 */
export function mutateJson(file, mutator, fallback) {
  const prev = _fileChains.get(file) || Promise.resolve()
  const run = prev.then(async () => {
    const current = await readJson(file, fallback)
    const next = await mutator(current)
    if (next !== undefined) await writeJson(file, next)
    return next
  })
  // В цепочке держим версию, которая никогда не реджектит, — иначе одна ошибка
  // заблокировала бы все последующие операции над файлом.
  _fileChains.set(file, run.catch(() => {}))
  return run
}
