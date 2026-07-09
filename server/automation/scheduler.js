import { listRules, updateRule, computeNextRun } from './store.js'

const TICK_MS = 30_000

/** Правила, которые прямо сейчас запускаются (защита от двойного старта в одном тике). @type {Set<string>} */
const launching = new Set()
let timer = null

/**
 * Запустить задачу модуля по правилу через универсальный реестр модулей.
 * Все ключи (включая neuro-commenting) обслуживаются registry/WORKERS.
 * @param {import('./store.js').AutomationRule} rule
 */
async function launchRule(rule) {
  const { startModuleTask, launchTask, getModuleStore } = await import('../modules/registry.js')
  const settings = {
    ...(rule.settings || {}),
    accountIds: rule.accountIds || rule.settings?.accountIds || [],
  }
  const { task, store } = startModuleTask(rule.moduleKey, settings)
  await launchTask(rule.moduleKey, task, store)
  // подстраховка: убедимся, что стор существует (иначе launchTask no-op)
  if (!getModuleStore(rule.moduleKey)) throw new Error('Модуль не поддерживается планировщиком')
  return task.id
}

async function tick() {
  let rules
  try {
    rules = await listRules()
  } catch {
    return
  }
  const now = Date.now()
  for (const rule of rules) {
    if (!rule.enabled) continue
    const nextRun = rule.nextRun ?? computeNextRun(rule, now)
    if (!nextRun || nextRun > now) continue
    if (launching.has(rule.id)) continue
    launching.add(rule.id)
    try {
      const taskId = await launchRule(rule)
      const patch = {
        lastRun: now,
        lastStatus: 'launched',
        lastTaskId: taskId,
      }
      // 'once' — отключаем после единственного запуска
      if (rule.schedule?.type === 'once') patch.enabled = false
      await updateRule(rule.id, patch)
      console.log(`[automation] rule ${rule.id} (${rule.moduleKey}) → task ${taskId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка запуска'
      // не сжигаем расписание при конфликте локов — просто сдвигаем следующий запуск
      await updateRule(rule.id, { lastRun: now, lastStatus: `error: ${msg}`.slice(0, 160) })
      console.warn(`[automation] rule ${rule.id} failed:`, msg)
    } finally {
      launching.delete(rule.id)
    }
  }
}

/** Пересчитать nextRun для всех правил и запустить интервальный раннер. */
export async function startScheduler() {
  try {
    const rules = await listRules()
    for (const rule of rules) {
      const nextRun = computeNextRun(rule)
      if (nextRun !== rule.nextRun) await updateRule(rule.id, {})
    }
  } catch { /* ignore */ }
  if (timer) clearInterval(timer)
  timer = setInterval(() => { void tick() }, TICK_MS)
  // первый прогон вскоре после старта
  setTimeout(() => { void tick() }, 5_000)
  console.log('[automation] scheduler started')
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

/** Запустить правило немедленно (для кнопки «Запустить сейчас»). @param {string} ruleId */
export async function runRuleNow(ruleId) {
  const rules = await listRules()
  const rule = rules.find((r) => r.id === ruleId)
  if (!rule) throw new Error('Правило не найдено')
  const taskId = await launchRule(rule)
  await updateRule(rule.id, { lastRun: Date.now(), lastStatus: 'launched (manual)', lastTaskId: taskId })
  return taskId
}
