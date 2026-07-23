import { apiGet, apiPost, apiPut, apiDelete } from './client'

/**
 * Агент (AI-персона) — «как общаться», отдельно от Цели («что достичь»).
 * Решение созвона 22.07. Выбирается в задаче кампании, как выбирается цель.
 */
export interface AgentFollowUp {
  enabled: boolean
  limit: number
  instructions: string
}

export interface Agent {
  id: string
  name: string
  /** Тон общения — как писать. */
  toneOfVoice: string
  /** Ограничения — чего писать нельзя. */
  restrictions: string
  /** Характер/роль свободным текстом: «дружелюбный эксперт», «скептик-спорщик». */
  character: string
  /** Язык общения; пусто — язык собеседника. */
  language: string
  /** Дожим — настойчивость персоны, если человек написал после закрытия. */
  followUp: AgentFollowUp
  createdAt: number
  updatedAt: number
}

export interface AgentInput {
  name: string
  toneOfVoice?: string
  restrictions?: string
  character?: string
  language?: string
  followUp?: AgentFollowUp
}

export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

export async function fetchAgents(): Promise<Agent[]> {
  const data = await apiGet<{ agents: Agent[] }>('/api/agents')
  return data.agents
}

export async function createAgent(input: AgentInput): Promise<Agent> {
  const data = await apiPost<{ agent: Agent }>('/api/agents', input)
  return data.agent
}

export async function updateAgent(id: string, patch: Partial<AgentInput>): Promise<Agent> {
  const data = await apiPut<{ agent: Agent }>(`/api/agents/${id}`, patch)
  return data.agent
}

export async function deleteAgent(id: string): Promise<void> {
  await apiDelete(`/api/agents/${id}`)
}
