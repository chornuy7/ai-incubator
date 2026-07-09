import type { LogEntry } from '@/shared/types'
import { apiGet, apiPost } from './client'

export interface ModuleTaskSettings {
  accountIds: string[]
  targets?: string[]
  channels?: string[]
  keywords?: string[]
  commentMode?: number
  workMode?: number
  postFilter?: number
  probability?: number
  maxActions?: number
  maxComments?: number
  maxPerAccount?: number
  // ── (4) Минимумы: воркер выбирает цель в диапазоне [min, max] ──
  minActions?: number
  minPerAccount?: number
  minWords?: number
  durationMinutes?: number
  aiProtection?: boolean
  protectionLevel?: number
  promptIndex?: number
  promptText?: string
  promptOverrides?: string[]
  aiMode?: number
  delayPreset?: number
  emojis?: string[]
  postUrls?: string[]
  limit?: number
  // ── Парсер каналов/групп ──
  searchMode?: number // 0 = по ключевым словам, 1 = похожие каналы
  endings?: string[]
  minMembers?: number
  maxMembers?: number
  resultLimit?: number // 0 = без лимита
  activityFilter?: number // 0 любая / 1 активные / 2 неактивные
  commentFilter?: number // 0 любые / 1 открытые / 2 закрытые
  minComments?: number
  langDetection?: boolean
  alreadyParsed?: string[]
  // ── Парсер участников (users/messages/comments) ──
  filters?: Record<string, boolean>
  limits?: Record<string, number>
  activeStories?: boolean
  delayChat?: number
  delayItem?: number
  fromTgstat?: { category: string; region: string | null; maxPages: number } | null
  delays?: {
    comment?: [number, number]
    action?: [number, number]
    join?: [number, number]
    request?: [number, number]
    channel?: [number, number]
    floodWait?: number
    floodQuarantine?: number
  }
}

export interface ModuleTaskProgress {
  done: number
  total: number
  actionsDone?: number
  commentsSent?: number
}

export interface ModuleTask {
  id: string
  moduleKey: string
  status: 'queued' | 'running' | 'stopped' | 'done' | 'error'
  createdAt: number
  updatedAt: number
  progress: ModuleTaskProgress
  settings: ModuleTaskSettings
  logs: LogEntry[]
  history?: Record<string, unknown>[]
  commentHistory?: Record<string, unknown>[]
  results?: Record<string, unknown>[]
  accountStats?: Record<string, { actions?: number; comments?: number; floodWaits: number }>
}

const base = (moduleKey: string) => `/api/modules/${moduleKey}`

export async function startModuleTask(moduleKey: string, settings: ModuleTaskSettings): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks`, { settings })
  return data.task
}

export async function fetchModuleTasks(moduleKey: string): Promise<ModuleTask[]> {
  const data = await apiGet<{ tasks: ModuleTask[] }>(`${base(moduleKey)}/tasks`)
  return data.tasks
}

export async function fetchModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiGet<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}`)
  return data.task
}

export async function stopModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/stop`)
  return data.task
}

export async function saveModulePreset(moduleKey: string, name: string, settings: ModuleTaskSettings) {
  return apiPost(`${base(moduleKey)}/presets`, { name, settings })
}

export async function fetchModulePresets(moduleKey: string) {
  const data = await apiGet<{ presets: { id: string; name: string; createdAt: number }[] }>(`${base(moduleKey)}/presets`)
  return data.presets
}

export async function listModuleKeys() {
  const data = await apiGet<{ modules: string[] }>('/api/modules')
  return data.modules
}

/** Legacy neuro-commenting API (backward compat) */
export { startNeuroCommentingTask, fetchNeuroTask, stopNeuroTask } from './neuroCommentingApi'
