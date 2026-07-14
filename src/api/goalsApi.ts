import { apiGet, apiPost, apiDelete, parseJson } from './client'

export interface Goal {
  id: string
  name: string
  description: string
  targetAction: string
  stages: string[]
  completionCriteria: string
  audience: string
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
