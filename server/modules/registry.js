import { createTaskStore } from '../lib/taskStore.js'
import { WORKERS, startWorker, stopWorker } from './workers.js'
import { tryAcquireLocks } from '../lib/accountLocks.js'

/** @type {Record<string, ReturnType<typeof createTaskStore>>} */
const stores = {}

/** @type {Record<string, { idPrefix: string, requiresTargets?: boolean, targetLabel?: string, initProgress?: (s: object) => object }>} */
export const MODULE_DEFS = {
  'neuro-commenting': { idPrefix: 'nc', requiresTargets: true, targetLabel: 'канал' },
  'neuro-chatting': { idPrefix: 'nch', requiresTargets: true, targetLabel: 'группу' },
  'mass-react': { idPrefix: 'mr', requiresTargets: true, targetLabel: 'цель' },
  'mass-looking': { idPrefix: 'ml', requiresTargets: true, targetLabel: 'юзера/канал' },
  warming: { idPrefix: 'wm', requiresTargets: false },
  'neuro-dialogs': { idPrefix: 'nd', requiresTargets: false },
  ggr: { idPrefix: 'ggr', requiresTargets: false },
  parsing: { idPrefix: 'pr', requiresTargets: false },
  'parsing-groups': { idPrefix: 'pg', requiresTargets: false },
  'parsing-users': { idPrefix: 'pu', requiresTargets: true, targetLabel: 'группу' },
  'parsing-messages': { idPrefix: 'pm', requiresTargets: true, targetLabel: 'канал' },
  'parsing-comments': { idPrefix: 'pc', requiresTargets: true, targetLabel: 'канал' },
}

export function getModuleStore(moduleKey) {
  if (!MODULE_DEFS[moduleKey]) return null
  if (!stores[moduleKey]) stores[moduleKey] = createTaskStore(moduleKey, MODULE_DEFS[moduleKey].idPrefix)
  return stores[moduleKey]
}

export function getWorker(moduleKey) {
  return WORKERS[moduleKey] ?? null
}

/** min<=max проверка для пары полей (feature 4). */
function checkMinMax(settings, minKey, maxKey, label) {
  const min = Number(settings?.[minKey] ?? 0) || 0
  const max = Number(settings?.[maxKey] ?? 0) || 0
  if (min && max && min > max) return `Минимум больше максимума: ${label}`
  return null
}

export function validateSettings(moduleKey, settings) {
  const def = MODULE_DEFS[moduleKey]
  if (!def) return 'Неизвестный модуль'
  if (moduleKey !== 'ggr' && !settings?.accountIds?.length) return 'Выберите хотя бы один аккаунт'
  const tgs = settings?.targets || settings?.channels || []
  if (def.requiresTargets && !tgs.length) {
    if (moduleKey === 'mass-react' && settings?.postUrls?.length) { /* посты вместо групп */ }
    else return `Добавьте хотя бы одну ${def.targetLabel || 'цель'}`
  }
  // feature 4: min <= max для всех парных лимитов
  return (
    checkMinMax(settings, 'minActions', 'maxActions', 'действия') ||
    checkMinMax(settings, 'minComments', 'maxComments', 'комментарии') ||
    checkMinMax(settings, 'minPerAccount', 'maxPerAccount', 'на аккаунт') ||
    null
  )
}

export function startModuleTask(moduleKey, settings) {
  const store = getModuleStore(moduleKey)
  const worker = getWorker(moduleKey)
  if (!store || !worker) throw new Error('Модуль не поддерживается')

  const err = validateSettings(moduleKey, settings)
  if (err) throw new Error(err)

  if (moduleKey === 'mass-looking') {
    settings.lookMode = ['stories', 'posts', 'both'].includes(settings.lookMode) ? settings.lookMode : 'stories'
    if (settings.lookMode !== 'stories') {
      settings.lookPostsCount = Math.min(Math.max(Math.trunc(Number(settings.lookPostsCount) || 0) || 3, 1), 50)
    }
  }

  const max = settings.maxActions ?? settings.maxComments ?? 100
  const task = store.createTask(settings, {
    progress: { done: 0, total: max, actionsDone: 0, commentsSent: 0 },
    results: [],
    commentHistory: [],
  })
  const lockErr = tryAcquireLocks(settings.accountIds, moduleKey, task.id)
  if (lockErr) throw new Error(lockErr)
  return { store, task, worker }
}

export async function launchTask(moduleKey, task, store) {
  const worker = getWorker(moduleKey)
  if (!worker) return
  await store.saveTask(task)
  startWorker(task.id, store, worker)
}

export async function stopModuleTask(moduleKey, taskId) {
  const store = getModuleStore(moduleKey)
  if (!store) return null
  return stopWorker(taskId, store)
}

export function listModuleKeys() {
  return Object.keys(MODULE_DEFS)
}
