/**
 * Аренда канала (lease) — «один канал в конкретный момент обновляет только один бот» (§3.9, §4).
 * Реализует docs/CONTRACT-locks-lease.md §4. В отличие от lock аккаунта (accountLocks.js),
 * lease самоистекает по TTL — зависший без renew бот освобождает канал.
 *
 * Хранение — в памяти процесса (Map), как и локи. Все функции принимают `now` для тестируемости.
 */

/** @type {Map<string, { botId: string, taskId: string, until: number }>} */
const leases = new Map()

/**
 * Захватить/продлить lease канала. Атомарно (single-thread JS): compare-and-set в Map.
 * Возвращает null при успехе или объект-конфликт, если канал держит другая задача.
 * @param {string} channelId @param {string} botId @param {string} taskId @param {number} ttlMs @param {number} [now]
 * @returns {null | { code: 'CHANNEL_LEASED', by: string, taskId: string, until: number }}
 */
export function acquireChannelLease(channelId, botId, taskId, ttlMs, now = Date.now()) {
  const cur = leases.get(channelId)
  if (cur && cur.until > now && cur.taskId !== taskId) {
    return { code: 'CHANNEL_LEASED', by: cur.botId, taskId: cur.taskId, until: cur.until }
  }
  leases.set(channelId, { botId, taskId, until: now + ttlMs })
  return null
}

/**
 * Продлить свой lease. true если продлили (владелец — та же задача), иначе false.
 * @param {string} channelId @param {string} taskId @param {number} ttlMs @param {number} [now]
 */
export function renewChannelLease(channelId, taskId, ttlMs, now = Date.now()) {
  const cur = leases.get(channelId)
  if (!cur || cur.taskId !== taskId) return false
  cur.until = now + ttlMs
  return true
}

/**
 * Освободить lease. Без taskId — снять безусловно; с taskId — только если владелец совпал.
 * @param {string} channelId @param {string} [taskId]
 */
export function releaseChannelLease(channelId, taskId) {
  const cur = leases.get(channelId)
  if (cur && (!taskId || cur.taskId === taskId)) {
    leases.delete(channelId)
    return true
  }
  return false
}

/** Снять все лизы задачи (при завершении/остановке). @param {string} taskId */
export function releaseTaskLeases(taskId) {
  for (const [cid, l] of [...leases]) {
    if (l.taskId === taskId) leases.delete(cid)
  }
}

/** Текущий активный lease канала (null если нет или истёк). @param {string} channelId @param {number} [now] */
export function getChannelLease(channelId, now = Date.now()) {
  const cur = leases.get(channelId)
  if (!cur || cur.until <= now) return null
  return { botId: cur.botId, taskId: cur.taskId, until: cur.until }
}

/** Снять протухшие лизы (now > until). Возвращает снятые. @param {number} [now] */
export function reconcileLeases(now = Date.now()) {
  /** @type {{ channelId: string, botId: string, taskId: string }[]} */
  const expired = []
  for (const [cid, l] of [...leases]) {
    if (l.until <= now) {
      leases.delete(cid)
      expired.push({ channelId: cid, botId: l.botId, taskId: l.taskId })
    }
  }
  return expired
}

/** Только для тестов: очистить все лизы. */
export function _resetLeases() {
  leases.clear()
}
