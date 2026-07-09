/** Глобальные блокировки аккаунтов — один аккаунт = одна задача на всех модулях. */

/** @type {Map<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
const locks = new Map()

/**
 * Реестр задач, у которых прямо сейчас крутится воркер в этом процессе.
 * Блокировки, чей taskId не «живой» и не running/queued на диске, считаются устаревшими.
 * @type {Set<string>}
 */
const liveTasks = new Set()

export const MODULE_LABELS = {
  'neuro-commenting': 'Нейрокомментинг',
  'neuro-chatting': 'Нейрочаттинг',
  'mass-react': 'Массовые реакции',
  'mass-looking': 'Масслукинг',
  warming: 'Прогрев',
  'neuro-dialogs': 'НейроДиалоги',
  ggr: 'GGR · Рейтинг',
  parsing: 'Парсинг',
  'parsing-groups': 'Парсинг групп',
  'parsing-users': 'Парсинг юзеров',
  'parsing-messages': 'Парсинг сообщений',
  'parsing-comments': 'Парсинг комментариев',
}

/** @param {string} moduleKey */
export function moduleLabel(moduleKey) {
  return MODULE_LABELS[/** @type {keyof typeof MODULE_LABELS} */ (moduleKey)] || moduleKey
}

/** @param {string} accountId */
export function getAccountLock(accountId) {
  return locks.get(accountId) ?? null
}

/** @returns {Record<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
export function getAllAccountLocks() {
  /** @type {Record<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
  const out = {}
  for (const [id, lock] of locks) out[id] = { ...lock }
  return out
}

/** @param {string[]} accountIds @param {string} moduleKey @param {string} taskId @param {{ force?: boolean }} [opts] */
export function tryAcquireLocks(accountIds, moduleKey, taskId, opts = {}) {
  const label = moduleLabel(moduleKey)
  /** @type {{ accountId: string, moduleKey: string, taskId: string, moduleLabel: string }[]} */
  const conflicts = []

  for (const accountId of accountIds || []) {
    const existing = locks.get(accountId)
    if (existing && existing.taskId !== taskId) {
      conflicts.push({ accountId, ...existing })
    }
  }

  if (conflicts.length && !opts.force) {
    const names = conflicts.map((c) => `${c.accountId.slice(-6)} → ${c.moduleLabel}`).join(', ')
    return `Аккаунты заняты другой задачей: ${names}. Остановите её или выберите другие профили.`
  }

  for (const accountId of accountIds || []) {
    locks.set(accountId, { moduleKey, taskId, moduleLabel: label, since: Date.now() })
  }
  return null
}

/** @param {string} taskId */
export function releaseTaskLocks(taskId) {
  for (const [accountId, lock] of locks) {
    if (lock.taskId === taskId) locks.delete(accountId)
  }
}

/** Принудительно снять блокировку с конкретного аккаунта (ручной разблок стухшего лока). @param {string} accountId */
export function forceReleaseAccount(accountId) {
  const lock = locks.get(accountId)
  if (!lock) return null
  locks.delete(accountId)
  return lock
}

/** @param {string} accountId @param {string} [taskId] */
export function assertAccountAvailable(accountId, taskId) {
  const lock = locks.get(accountId)
  if (!lock) return
  if (taskId && lock.taskId === taskId) return
  throw new Error(`ACCOUNT_BUSY:${lock.moduleLabel}`)
}

// ── Живой реестр воркеров ──────────────────────────────────────────────

/** @param {string} taskId */
export function markTaskLive(taskId) {
  if (taskId) liveTasks.add(taskId)
}

/** @param {string} taskId */
export function markTaskDone(taskId) {
  liveTasks.delete(taskId)
}

/** @param {string} taskId */
export function isTaskLive(taskId) {
  return liveTasks.has(taskId)
}

// ── Согласование блокировок с реальным состоянием ──────────────────────

/**
 * Найти статус задачи по её id среди всех стораджей (universal + neuro-commenting).
 * @param {string} taskId
 * @returns {Promise<string | null>}
 */
async function findTaskStatus(taskId) {
  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const t = await store.loadTask(taskId)
      if (t) return t.status || null
    }
  } catch { /* ignore */ }

  try {
    const { loadTask } = await import('../neuroCommenting/taskStore.js')
    const t = await loadTask(taskId)
    if (t) return t.status || null
  } catch { /* ignore */ }

  return null
}

/**
 * Самолечение: снять блокировки, чей taskId не «живой» в процессе
 * и не имеет статуса running/queued на диске (задача завершена/удалена/устарела).
 * @returns {Promise<{ accountId: string, taskId: string, moduleKey: string }[]>}
 */
export async function reconcileLocks() {
  if (!locks.size) return []
  /** @type {{ accountId: string, taskId: string, moduleKey: string }[]} */
  const dropped = []
  for (const [accountId, lock] of [...locks]) {
    if (isTaskLive(lock.taskId)) continue
    const status = await findTaskStatus(lock.taskId)
    if (status === 'running' || status === 'queued') continue
    locks.delete(accountId)
    dropped.push({ accountId, taskId: lock.taskId, moduleKey: lock.moduleKey })
  }
  return dropped
}

/**
 * Согласование на старте API. Воркеры живут только в памяти процесса, поэтому
 * после перезапуска ни один «running/queued» таск на диске уже не выполняется.
 * Такие задачи помечаем как stopped (устаревшие) и НЕ восстанавливаем блокировки —
 * иначе аккаунт остался бы «в работе» навсегда без единого воркера.
 * @returns {Promise<{ flipped: string[] }>}
 */
export async function reconcileStaleTasksOnBoot() {
  locks.clear()
  liveTasks.clear()
  /** @type {string[]} */
  const flipped = []

  const flipStale = async (full, store) => {
    full.status = 'stopped'
    full.stopRequested = true
    full.staleStoppedAt = Date.now()
    if (typeof store.appendLog === 'function') {
      await store.appendLog(full, 'warning', 'Задача остановлена: перезапуск API (воркер не пережил рестарт)')
    } else {
      await store.saveTask(full)
    }
    flipped.push(full.id)
  }

  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const tasks = await store.listTasks()
      for (const t of tasks) {
        if (t.status !== 'running' && t.status !== 'queued') continue
        const full = await store.loadTask(t.id)
        if (!full) continue
        await flipStale(full, store)
      }
    }
  } catch { /* ignore */ }

  try {
    const ncStore = await import('../neuroCommenting/taskStore.js')
    const tasks = await ncStore.listTasks()
    for (const t of tasks) {
      if (t.status !== 'running' && t.status !== 'queued') continue
      const full = await ncStore.loadTask(t.id)
      if (!full) continue
      await flipStale(full, ncStore)
    }
  } catch { /* ignore */ }

  return { flipped }
}
