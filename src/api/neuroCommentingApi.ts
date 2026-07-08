import type { LogEntry } from '@/shared/types'

export interface NeuroCommentingSettings {
  accountIds: string[]
  channels: string[]
  commentMode: number
  workMode: number
  postFilter: number
  probability: number
  maxComments: number
  maxPerAccount: number
  minWords: number
  durationMinutes?: number
  aiProtection: boolean
  protectionLevel: number
  promptIndex: number
  promptText?: string
  promptOverrides?: string[]
  aiMode: number
  keywords: string[]
  delayPreset: number
  delays: {
    comment: [number, number]
    join: [number, number]
    floodWait: number
    floodQuarantine: number
  }
}

export interface CommentHistoryItem {
  id: string
  ts: string
  accountId: string
  accountName: string
  channel: string
  postId: number
  comment: string
  status: 'sent' | 'deleted' | 'failed'
}

export interface NeuroTaskProgress {
  done: number
  total: number
  commentsSent: number
}

export interface NeuroTask {
  id: string
  status: 'queued' | 'running' | 'stopped' | 'done' | 'error'
  createdAt: number
  updatedAt: number
  progress: NeuroTaskProgress
  settings: NeuroCommentingSettings
  logs: LogEntry[]
  commentHistory: CommentHistoryItem[]
  accountStats: Record<string, { comments: number; floodWaits: number }>
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function startNeuroCommentingTask(settings: NeuroCommentingSettings): Promise<NeuroTask> {
  const data = await post<{ task: NeuroTask }>('/api/neuro-commenting/tasks', { settings })
  return data.task
}

export async function fetchNeuroTasks(): Promise<Pick<NeuroTask, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'progress'>[]> {
  const data = await get<{ tasks: Pick<NeuroTask, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'progress'>[] }>('/api/neuro-commenting/tasks')
  return data.tasks
}

export async function fetchNeuroTask(taskId: string): Promise<NeuroTask> {
  const data = await get<{ task: NeuroTask }>(`/api/neuro-commenting/tasks/${taskId}`)
  return data.task
}

export async function stopNeuroTask(taskId: string): Promise<NeuroTask> {
  const data = await post<{ task: NeuroTask }>(`/api/neuro-commenting/tasks/${taskId}/stop`)
  return data.task
}

export async function fetchNeuroPresets(): Promise<{ id: string; name: string; settings: NeuroCommentingSettings; createdAt: number }[]> {
  const data = await get<{ presets: { id: string; name: string; settings: NeuroCommentingSettings; createdAt: number }[] }>('/api/neuro-commenting/presets')
  return data.presets
}

export async function saveNeuroPreset(name: string, settings: NeuroCommentingSettings) {
  return post('/api/neuro-commenting/presets', { name, settings })
}

export async function fetchCommentHistory(): Promise<CommentHistoryItem[]> {
  const data = await get<{ history: CommentHistoryItem[] }>('/api/neuro-commenting/history')
  return data.history
}
