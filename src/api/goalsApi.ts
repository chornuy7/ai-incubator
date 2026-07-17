import { apiGet, apiPost, apiDelete, parseJson } from './client'

export interface Goal {
  id: string
  name: string
  description: string
  targetAction: string
  stages: string[]
  completionCriteria: string
  audience: string
  channels: string[]
  createdAt: number
  updatedAt: number
}

export interface GoalInput {
  name: string
  description?: string
  targetAction?: string
  stages?: string[]
  completionCriteria?: string
  audience?: string
  channels?: string[]
}

export async function fetchGoals(): Promise<Goal[]> {
  const data = await apiGet<{ ok: boolean; goals: Goal[] }>('/api/goals')
  return data.goals
}

export async function createGoal(input: GoalInput): Promise<Goal> {
  const data = await apiPost<{ ok: boolean; goal: Goal }>('/api/goals', input)
  return data.goal
}

export async function updateGoal(id: string, patch: Partial<GoalInput>): Promise<Goal> {
  const res = await fetch(`/api/goals/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseJson<{ ok: boolean; goal: Goal }>(res)
  return data.goal
}

export async function deleteGoal(id: string): Promise<void> {
  await apiDelete(`/api/goals/${id}`)
}

// ── База знаний цели (§3.6) ──
export interface KbItem {
  id: string
  goalId: string
  kind: 'text' | 'file' | 'image'
  title: string
  content: string
  fileRef: string | null
  scope: string
  version: number
  createdAt: number
  updatedAt: number
}

export async function fetchKb(goalId: string): Promise<KbItem[]> {
  const data = await apiGet<{ ok: boolean; items: KbItem[] }>(`/api/goals/${goalId}/kb`)
  return data.items
}

export async function createKb(goalId: string, input: { title?: string; content: string }): Promise<KbItem> {
  const data = await apiPost<{ ok: boolean; item: KbItem }>(`/api/goals/${goalId}/kb`, input)
  return data.item
}

export async function deleteKb(goalId: string, kbId: string): Promise<void> {
  await apiDelete(`/api/goals/${goalId}/kb/${kbId}`)
}
