/** Глобальные блокировки аккаунтов — один аккаунт = одна задача на всех модулях. */

/** @type {Map<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
const locks = new Map()

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

/** @param {string} accountId @param {string} [taskId] */
export function assertAccountAvailable(accountId, taskId) {
  const lock = locks.get(accountId)
  if (!lock) return
  if (taskId && lock.taskId === taskId) return
  throw new Error(`ACCOUNT_BUSY:${lock.moduleLabel}`)
}

/** Восстановить блокировки после перезапуска API по running-задачам на диске. */
export async function rebuildLocksFromRunningTasks() {
  locks.clear()

  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const tasks = await store.listTasks()
      for (const t of tasks) {
        if (t.status !== 'running' && t.status !== 'queued') continue
        tryAcquireLocks(t.settings?.accountIds || [], key, t.id, { force: false })
      }
    }
  } catch { /* ignore */ }

  try {
    const { listTasks, loadTask } = await import('../neuroCommenting/taskStore.js')
    const tasks = await listTasks()
    for (const t of tasks) {
      if (t.status !== 'running' && t.status !== 'queued') continue
      const full = await loadTask(t.id)
      tryAcquireLocks(full?.settings?.accountIds || [], 'neuro-commenting', t.id, { force: false })
    }
  } catch { /* ignore */ }
}
