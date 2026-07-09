import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = dataPath('target-folders.json')

function newId() {
  return `fld_${crypto.randomUUID().slice(0, 8)}`
}

function normalizeTargets(targets) {
  const arr = Array.isArray(targets) ? targets : []
  const clean = arr
    .map((t) => String(t || '').trim().replace(/^@/, ''))
    .filter(Boolean)
  return [...new Set(clean)]
}

/** @returns {Promise<Array<{id:string,name:string,targets:string[],createdAt:number,updatedAt:number}>>} */
export async function listFolders() {
  const data = await readJson(FILE, { folders: [] })
  return Array.isArray(data?.folders) ? data.folders : []
}

async function saveFolders(folders) {
  await writeJson(FILE, { folders, updatedAt: Date.now() })
}

/** @param {string} name @param {string[]} targets */
export async function createFolder(name, targets) {
  const folders = await listFolders()
  const folder = {
    id: newId(),
    name: String(name || '').trim() || 'Без названия',
    targets: normalizeTargets(targets),
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
