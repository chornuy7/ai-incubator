import type { TaskStatus } from '@/shared/types'

const key = (scope: string) => `ai-incubator:activeTask:${scope}`

export function persistActiveTaskId(scope: string, taskId: string | null) {
  try {
    if (taskId) sessionStorage.setItem(key(scope), taskId)
    else sessionStorage.removeItem(key(scope))
  } catch { /* ignore */ }
}

export function readActiveTaskId(scope: string): string | null {
  try {
    return sessionStorage.getItem(key(scope))
  } catch {
    return null
  }
}

/** @param {string} status */
export function mapTaskStatus(status: string): TaskStatus {
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'error') return 'error'
  if (status === 'queued') return 'queued'
  return 'paused'
}

/** Восстанавливаем только задачу из текущей сессии вкладки (sessionStorage), не любую running на сервере. */
export function pickTaskIdToRestore(tasks: { id: string; status: string }[], storedId: string | null) {
  if (!storedId) return null
  return tasks.some((t) => t.id === storedId) ? storedId : null
}
