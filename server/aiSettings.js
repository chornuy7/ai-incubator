import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = dataPath('ai-settings.json')

const DEFAULTS = {
  /** Глобальный системный промпт — добавляется ко всем генерациям ИИ во всех модулях. */
  globalSystemPrompt: '',
  updatedAt: 0,
}

/** In-memory кэш для синхронного доступа из воркеров/генератора. */
let cache = { ...DEFAULTS }
let loaded = false

/** Загрузить настройки с диска в кэш (вызывать на старте API). */
export async function loadAiSettings() {
  const data = await readJson(FILE, {})
  cache = { ...DEFAULTS, ...(data || {}) }
  loaded = true
  return { ...cache }
}

/** @returns {Promise<typeof DEFAULTS>} */
export async function getAiSettings() {
  if (!loaded) await loadAiSettings()
  return { ...cache }
}

/** Синхронно вернуть глобальный системный промпт (пустая строка если не задан/не загружен). */
export function getGlobalSystemPromptSync() {
  return cache.globalSystemPrompt || ''
}

/** @param {{ globalSystemPrompt?: string }} patch */
export async function setAiSettings(patch) {
  if (!loaded) await loadAiSettings()
  const next = {
    ...cache,
    ...(typeof patch?.globalSystemPrompt === 'string' ? { globalSystemPrompt: patch.globalSystemPrompt } : {}),
    updatedAt: Date.now(),
  }
  cache = next
  await writeJson(FILE, next)
  return { ...cache }
}
