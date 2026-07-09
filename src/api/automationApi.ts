import { apiGet, apiPost } from './client'
import type { ModuleTaskSettings } from './modulesApi'

export interface AutomationSchedule {
  type: 'once' | 'interval' | 'daily'
  at?: number
  intervalMinutes?: number
  time?: string
}

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  moduleKey: string
  accountIds: string[]
  settings: Partial<ModuleTaskSettings>
  schedule: AutomationSchedule
  lastRun: number | null
  lastStatus: string | null
  lastTaskId: string | null
  nextRun: number | null
  createdAt: number
  updatedAt: number
}

export type AutomationRuleInput = Pick<AutomationRule, 'name' | 'moduleKey' | 'accountIds' | 'settings' | 'schedule'> & {
  enabled?: boolean
}

export async function fetchAutomationRules(): Promise<AutomationRule[]> {
  const data = await apiGet<{ rules: AutomationRule[] }>('/api/automation/rules')
  return data.rules
}

export async function createAutomationRule(input: AutomationRuleInput): Promise<AutomationRule> {
  const data = await apiPost<{ rule: AutomationRule }>('/api/automation/rules', input)
  return data.rule
}

export async function updateAutomationRule(id: string, patch: Partial<AutomationRuleInput>): Promise<AutomationRule> {
  const res = await fetch(`/api/automation/rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.rule as AutomationRule
}

export async function deleteAutomationRule(id: string): Promise<void> {
  const res = await fetch(`/api/automation/rules/${id}`, { method: 'DELETE' })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
}

export async function runAutomationRuleNow(id: string): Promise<string> {
  const data = await apiPost<{ taskId: string }>(`/api/automation/rules/${id}/run`)
  return data.taskId
}
