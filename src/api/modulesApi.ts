import type { LogEntry } from '@/shared/types'
import { apiGet, apiPost, apiDelete } from './client'

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
  intersect?: boolean // §3.8: AND-пересечение — канал должен совпасть со ВСЕМИ ключевыми словами
  // ── Парсер участников (users/messages/comments) ──
  filters?: Record<string, boolean>
  limits?: Record<string, number>
  activeStories?: boolean
  intersectionMode?: boolean
  intersectionMin?: number
  userSource?: 'participants' | 'writers' // как парсить users: список участников или кто писал в чате
  delayChat?: number
  delayItem?: number
  // ── Прогрев: уровень (0=2д, 1=3–7д, 2=7–14д) ──
  warmLevel?: number
  // ── Нейрокомментинг: окно последних постов (§3.5) ──
  postWindow?: number
  // ── Распределение типов комментариев в % (§3.5), сумма ≈ 100 ──
  typeWeights?: number[]
  // ── Цель кампании (§3.6) ──
  goalId?: string
  // ── НейроДиалоги ──
  replyScope?: 'unread' | 'all' // 'unread' — только новые ЛС, 'all' — все, где последнее слово за собеседником
  dialogGoal?: string // инструкция для ИИ: как себя вести и к чему вести диалог
  // ── Масслукинг: что смотреть и сколько последних постов ──
  lookMode?: 'stories' | 'posts' | 'both'
  lookPostsCount?: number
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
  status: 'queued' | 'running' | 'stopped' | 'done' | 'error' | 'paused'
  initiator?: string | null
  goalId?: string | null
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

export async function restartModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/restart`)
  return data.task
}

export async function pauseModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/pause`)
  return data.task
}

export async function resumeModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/resume`)
  return data.task
}

/** Все задачи по всем модулям (дашборд «Задачи», §3.9). */
export async function fetchAllTasks(): Promise<ModuleTask[]> {
  const data = await apiGet<{ tasks: ModuleTask[] }>('/api/modules/tasks')
  return data.tasks
}

export interface ModulePreset {
  id: string
  name: string
  createdAt: number
  settings: ModuleTaskSettings
}

export async function saveModulePreset(moduleKey: string, name: string, settings: ModuleTaskSettings) {
  return apiPost(`${base(moduleKey)}/presets`, { name, settings })
}

export async function fetchModulePresets(moduleKey: string) {
  const data = await apiGet<{ presets: ModulePreset[] }>(`${base(moduleKey)}/presets`)
  return data.presets
}

export async function deleteModulePreset(moduleKey: string, id: string) {
  const data = await apiDelete<{ presets: Omit<ModulePreset, 'settings'>[] }>(`${base(moduleKey)}/presets/${id}`)
  return data.presets
}

export async function listModuleKeys() {
  const data = await apiGet<{ modules: string[] }>('/api/modules')
  return data.modules
}

/** Legacy neuro-commenting API (backward compat) */
export { startNeuroCommentingTask, fetchNeuroTask, stopNeuroTask } from './neuroCommentingApi'
