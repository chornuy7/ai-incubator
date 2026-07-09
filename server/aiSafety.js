import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = dataPath('ai-safety.json')

/**
 * Глобальные политики ИИ-безопасности. Дефолты подобраны так, чтобы СОХРАНИТЬ
 * текущее поведение системы, если файл не создан:
 *  - delayMultiplier / pacingMultiplier = 1 (без изменения задержек)
 *  - floodWaitExtraSeconds = 120, floodQuarantineThreshold = 3 (как хардкод раньше)
 *  - onBan = 'continue' (раньше бан просто логировался)
 *  - perAccountDailyCap = 0 (без суточного лимита)
 */
const DEFAULTS = {
  /** Что делать с аккаунтом при бане: 'continue' | 'quarantine' | 'stop-account' | 'stop-task'. */
  onBan: 'continue',
  /** Что делать при spamblock: 'skip' (пропускать) | 'quarantine'. */
  onSpamblock: 'skip',
  /** Доп. секунды паузы поверх FloodWait, если в настройках задачи не задано. */
  floodWaitExtraSeconds: 120,
  /** Сколько FloodWait подряд до карантина, если в настройках задачи не задано. */
  floodQuarantineThreshold: 3,
  /** Глобальный множитель всех задержек (>1 = медленнее/безопаснее). */
  delayMultiplier: 1,
  /** Множитель пейсинга активности (умножается к delayMultiplier). */
  pacingMultiplier: 1,
  /** Суточный лимит действий на аккаунт (0 = без лимита). Мягкое ограничение на уровне задачи. */
  perAccountDailyCap: 0,
  updatedAt: 0,
}

let cache = { ...DEFAULTS }
let loaded = false

export async function loadAiSafety() {
  const data = await readJson(FILE, {})
  cache = { ...DEFAULTS, ...(data || {}) }
  loaded = true
  return { ...cache }
}

export async function getAiSafety() {
  if (!loaded) await loadAiSafety()
  return { ...cache }
}

/** Синхронный доступ для воркеров/protection. Возвращает дефолты, пока не загружено. */
export function getAiSafetySync() {
  return { ...cache }
}

/** @param {Partial<typeof DEFAULTS>} patch */
export async function setAiSafety(patch) {
  if (!loaded) await loadAiSafety()
  const clean = {}
  const numeric = ['floodWaitExtraSeconds', 'floodQuarantineThreshold', 'delayMultiplier', 'pacingMultiplier', 'perAccountDailyCap']
  for (const k of numeric) {
    if (patch?.[k] !== undefined && Number.isFinite(Number(patch[k]))) clean[k] = Number(patch[k])
  }
  if (patch?.onBan) clean.onBan = String(patch.onBan)
  if (patch?.onSpamblock) clean.onSpamblock = String(patch.onSpamblock)
  cache = { ...cache, ...clean, updatedAt: Date.now() }
  await writeJson(FILE, cache)
  return { ...cache }
}

export { DEFAULTS as AI_SAFETY_DEFAULTS }
