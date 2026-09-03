import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { kvRead, kvWrite } from './lib/kvStore.js'

const FILE = dataPath('ai-settings.json')

/**
 * СТАНДАРТНЫЙ системный промпт — для тех, кто своего не задавал.
 *
 * С 27.08 промпт личный у каждого (MR-185). Но человек, который его ни разу не открывал,
 * не должен работать «без правил» — ему подставляется этот текст.
 *
 * Живёт в КОДЕ, а не в базе, намеренно. Раньше стандартный текст лежал записью в общем kv
 * и правился прямо на проде: к 27.08 он выглядел как «…без агрессии, без 12311» — хвост
 * чьего-то ручного прогона, который молча получали все, кто ничего не настраивал. В коде
 * он виден в истории, проходит ревью и не меняется случайным нажатием.
 *
 * Текст намеренно нейтральный и одинаково уместный во всех модулях: он добавляется ПЕРЕД
 * промптом карточки, а не вместо него, поэтому задаёт манеру, а не содержание.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'Пиши как обычный человек, от первого лица.',
  'Коротко и по делу, без канцелярита и рекламных штампов.',
  'Без агрессии, оскорблений и политики.',
  'Не сообщай, что ты ИИ или бот.',
].join(' ')

const DEFAULTS = {
  /**
   * Переопределение стандартного текста, если оно вообще заведено в хранилище.
   * Пусто — работает DEFAULT_SYSTEM_PROMPT из кода.
   */
  globalSystemPrompt: '',
  updatedAt: 0,
}

/** In-memory кэш для синхронного доступа из воркеров/генератора. */
let cache = { ...DEFAULTS }
let loaded = false

/** Загрузить настройки с диска в кэш (вызывать на старте API). */
export async function loadAiSettings() {
  const data = await kvRead('ai-settings', FILE, {})
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
  await kvWrite('ai-settings', FILE, next)
  return { ...cache }
}
