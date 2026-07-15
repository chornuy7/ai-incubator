/**
 * Детерминированный выбор цели в диапазоне [min, max] (feature 4).
 * Детерминированность по seed нужна, чтобы значение не «прыгало» при перезагрузке
 * задачи с диска между итерациями воркера.
 * @param {number} min
 * @param {number} max
 * @param {string} seed
 * @returns {number}
 */
export function seededTarget(min, max, seed = '') {
  const lo = Math.max(0, Math.floor(Number(min) || 0))
  const hiRaw = Math.max(0, Math.floor(Number(max) || 0))
  const hi = Math.max(lo, hiRaw)
  if (hi <= lo) return hi
  let h = 2166136261
  const s = String(seed)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const offset = (h >>> 0) % (hi - lo + 1)
  return lo + offset
}

/**
 * Эффективная общая цель задачи по количеству действий (feature 4).
 * @param {object} settings @param {object} task
 */
export function resolveTotalTarget(settings, task) {
  const max = settings.maxActions ?? settings.maxComments ?? 100
  const min = settings.minActions ?? settings.minComments ?? 0
  const t = seededTarget(min, max, task?.id || '')
  // Защита от «тихого нуля»: если задан положительный максимум, цель не может быть 0
  // (иначе задача запускается и молча ничего не делает — при min=0 seed мог дать 0).
  return max >= 1 ? Math.max(1, t) : t
}

/**
 * Эффективная цель на аккаунт (feature 4). Возвращает 0 если лимит не задан.
 * @param {object} settings @param {string} accountId @param {object} task
 */
export function resolvePerAccountTarget(settings, accountId, task) {
  const max = settings.maxPerAccount || 0
  if (!max) return 0
  const min = settings.minPerAccount || 0
  return seededTarget(min, max, `${task?.id || ''}:${accountId}`)
}
