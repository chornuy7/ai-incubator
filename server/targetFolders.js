import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = dataPath('target-folders.json')

function newId() {
  return `fld_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Цели папки: без `@`, без пробелов, без дублей — и в НИЖНЕМ регистре.
 *
 * Регистр критичен: юзернеймы Telegram регистронезависимы, `@nuancesprog` и
 * `@NUANCESPROG` — один канал. Без `toLowerCase()` они ложились в папку двумя
 * записями, и кампания отрабатывала по такому каналу ДВАЖДЫ одним аккаунтом —
 * повторные действия в один чат читаются как сигнатура бота (прогон 21–22.07,
 * тест 11.7: отправили 15 строк, сохранилось 13 вместо 12).
 * @param {*} targets
 */
export function normalizeTargets(targets) {
  const arr = Array.isArray(targets) ? targets : []
  const clean = arr
    .map((t) => String(t || '').trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean)
  return [...new Set(clean)]
}

/** Миграция регистра выполняется один раз за процесс — чтобы не писать файл на каждом чтении. */
let migrated = false

/** @returns {Promise<Array<{id:string,name:string,targets:string[],createdAt:number,updatedAt:number}>>} */
export async function listFolders() {
  const data = await readJson(FILE, { folders: [] })
  const folders = Array.isArray(data?.folders) ? data.folders : []
  // Папки, сохранённые до фикса регистра, содержат дубли вида nuancesprog + NUANCESPROG.
  // Сами они не исчезнут, поэтому схлопываем их при первом чтении и сохраняем результат.
  const fixed = folders.map((f) => ({ ...f, targets: normalizeTargets(f.targets) }))
  const changed = fixed.some((f, i) => f.targets.length !== (folders[i].targets?.length ?? 0))
  if (changed && !migrated) {
    migrated = true
    await saveFolders(fixed).catch(() => {})
  }
  return fixed
}

async function saveFolders(folders) {
  await writeJson(FILE, { folders, updatedAt: Date.now() })
}

/**
 * Владелец папки (`userId`).
 *
 * До 21.08 у папки владельца не было вообще, а `GET /api/target-folders` резал список
 * только ролью — и обычная роль клиента раздела `folders` не содержит, то есть не режет
 * ничего. На практике это значило, что база каналов (кого именно клиент собрался
 * обрабатывать — его ниша и его наработка) уходила любому другому клиенту платформы.
 *
 * Папки, заведённые ДО этого поля, остаются без владельца: угадать задним числом, чьи
 * они, нельзя. По общему правилу (`ownedForRequest`) их видит только админ.
 *
 * @param {string} name @param {string[]} targets @param {string} [userId] владелец пространства
 */
export async function createFolder(name, targets, userId) {
  const folders = await listFolders()
  const folder = {
    id: newId(),
    name: String(name || '').trim() || 'Без названия',
    targets: normalizeTargets(targets),
    userId: String(userId || '').trim() || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  folders.unshift(folder)
  await saveFolders(folders.slice(0, 200))
  return folder
}

/** @param {string} id @param {{ name?: string, targets?: string[] }} patch */
export async function updateFolder(id, patch) {
  const folders = await listFolders()
  const idx = folders.findIndex((f) => f.id === id)
  if (idx === -1) return null
  const cur = folders[idx]
  folders[idx] = {
    ...cur,
    ...(typeof patch?.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
    ...(patch?.targets !== undefined ? { targets: normalizeTargets(patch.targets) } : {}),
    updatedAt: Date.now(),
  }
  await saveFolders(folders)
  return folders[idx]
}

/** @param {string} id */
export async function deleteFolder(id) {
  const folders = await listFolders()
  const next = folders.filter((f) => f.id !== id)
  if (next.length === folders.length) return false
  await saveFolders(next)
  return true
}
