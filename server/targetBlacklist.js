import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = dataPath('target-blacklist.json')

/** Нормализация цели к сравнимому виду: без @, без https://t.me/, нижний регистр, без хвоста. */
export function normalizeTarget(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .replace(/https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase()
}

/** @type {Set<string>} */
let cache = new Set()
let loaded = false

export async function loadBlacklist() {
  const data = await readJson(FILE, { entries: [] })
  cache = new Set((data?.entries || []).map(normalizeTarget).filter(Boolean))
  loaded = true
  return [...cache]
}

export async function getBlacklist() {
  if (!loaded) await loadBlacklist()
  return [...cache]
}

/** Синхронный набор для фильтрации в воркерах. */
export function getBlacklistSetSync() {
  return cache
}

/** Синхронная проверка одной цели. @param {string} target */
export function isBlacklistedSync(target) {
  return cache.has(normalizeTarget(target))
}

/** Полностью заменить список. @param {string[]} entries */
export async function setBlacklist(entries) {
  cache = new Set((entries || []).map(normalizeTarget).filter(Boolean))
  await writeJson(FILE, { entries: [...cache], updatedAt: Date.now() })
  return [...cache]
}

/** Добавить одну/несколько целей. @param {string|string[]} entry */
export async function addToBlacklist(entry) {
  if (!loaded) await loadBlacklist()
  const list = Array.isArray(entry) ? entry : [entry]
  for (const e of list) {
    const n = normalizeTarget(e)
    if (n) cache.add(n)
  }
  await writeJson(FILE, { entries: [...cache], updatedAt: Date.now() })
  return [...cache]
}

/** Удалить одну цель. @param {string} entry */
export async function removeFromBlacklist(entry) {
  if (!loaded) await loadBlacklist()
  cache.delete(normalizeTarget(entry))
  await writeJson(FILE, { entries: [...cache], updatedAt: Date.now() })
  return [...cache]
}

/** Отфильтровать массив целей, убрав те, что в ЧС. @param {string[]} targets */
export function filterBlacklisted(targets) {
  if (!cache.size) return targets || []
  return (targets || []).filter((t) => !cache.has(normalizeTarget(t)))
}
