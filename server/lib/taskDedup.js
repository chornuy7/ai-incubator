/**
 * §7: проверка уникальности задачи перед запуском — не создавать вторую идентичную
 * активную задачу (те же аккаунты + цель + цели/каналы). Не «сканирование», а простая
 * проверка по подписи. Чистые функции — тестируются изолированно.
 */

/** Активные (незавершённые) статусы задачи. */
export const ACTIVE_TASK_STATUSES = new Set(['running', 'queued', 'paused'])

/**
 * Подпись задачи для сравнения: аккаунты + цель + цели/каналы (нормализованы, отсортированы).
 * @param {{accountIds?: string[], goalId?: string|null, channels?: string[], targets?: string[]}} settings
 * @returns {string}
 */
export function taskSignature(settings = {}) {
  const accs = [...new Set((settings.accountIds || []).map((x) => String(x)))].sort()
  const tgts = [...new Set((settings.channels || settings.targets || []).map((x) => String(x)))].sort()
  const goal = settings.goalId ? String(settings.goalId) : ''
  return JSON.stringify({ a: accs, g: goal, t: tgts })
}

/**
 * Найти активную задачу с той же подписью (дубль). Чистая функция.
 * @param {Array<{status?: string, settings?: object, id?: string}>} tasks
 * @param {object} settings
 * @returns {object|null}
 */
export function findDuplicateActiveTask(tasks, settings) {
  const sig = taskSignature(settings)
  return (Array.isArray(tasks) ? tasks : []).find(
    (t) => ACTIVE_TASK_STATUSES.has(t?.status) && taskSignature(t?.settings || {}) === sig,
  ) || null
}
