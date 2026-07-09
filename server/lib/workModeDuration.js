// Work mode duration "periods" mapping.
// We treat `durationMinutes` from UI as a max value, and derive a min
// depending on `protectionLevel` (0..2 from UI: conservative/balanced/aggressive).
//
// Example requirement: aggressive commenting uses period 30–100 minutes.
// => aggressive protectionLevel => min=30; UI durationMinutes=100 => period 30..100.

const MIN_BY_PROTECTION_LEVEL = [60, 45, 30]

function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * @param {{ durationMinutes?: number; protectionLevel?: number }} settings
 * @param {{ taskId?: string; startedAt?: number }=} seed
 * @returns {{ min: number; max: number; chosen: number } | null}
 */
export function resolveDurationPeriodMinutes(settings, seed = {}) {
  const max = Number(settings?.durationMinutes)
  if (!max || Number.isNaN(max) || max <= 0) return null

  const lvl = settings?.protectionLevel ?? 1
  const minCandidate = MIN_BY_PROTECTION_LEVEL[lvl] ?? 0

  const min = Math.min(minCandidate, max)
  const hi = Math.max(minCandidate, max)
  const range = hi - min

  // Deterministic choice so repeated checks don't shift the end time.
  const taskId = seed?.taskId ?? ''
  const startedAt = Number(seed?.startedAt ?? 0)
  const hasSeed = typeof taskId === 'string' && taskId.length > 0

  let offset
  if (hasSeed) {
    const h = hashString(taskId) ^ startedAt
    offset = h % (range + 1)
  } else {
    offset = Math.floor(Math.random() * (range + 1))
  }

  const chosen = min + offset
  return { min, max: hi, chosen }
}

