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
  const seeded = seededTarget(min, max, `${task?.id || ''}:${accountId}`)

  // Цель на аккаунт не должна делать НЕДОСТИЖИМОЙ общую цель задачи (правка 19.08).
  //
  // Прогон 19.08: «всего 2, на аккаунт 0–2», один аккаунт. Жребий дал ему 1, аккаунт
  // сделал один комментарий и упёрся в свой лимит — задача завершилась со статусом
  // «Готово» и прогрессом 1/2. Формально верно, по сути — задача не сделала того, что
  // сама же обещала: два разных случайных числа противоречили друг другу.
  //
  // Поэтому поднимаем цель аккаунта минимум до его доли общей цели, но НЕ выше заданного
  // максимума: максимум — прямое указание оператора, его перебивать нельзя. Если доля
  // всё равно выше максимума (аккаунтов слишком мало), задача честно завершится, а
  // воркер напишет, почему цель недостижима.
  const accounts = Array.isArray(settings.accountIds) && settings.accountIds.length
    ? settings.accountIds.length
    : 1
  const share = Math.ceil(resolveTotalTarget(settings, task) / accounts)
  return Math.min(max, Math.max(seeded, share))
}
