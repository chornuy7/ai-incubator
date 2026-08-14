import { apiGet, apiPost, apiPut, apiDelete } from './client'
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
  campaignId?: string | null // §6: правило под кампанией
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

export type AutomationRuleInput = Pick<AutomationRule, 'name' | 'moduleKey' | 'campaignId' | 'accountIds' | 'settings' | 'schedule'> & {
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
  const data = await apiPut<{ ok: boolean; rule: AutomationRule }>(`/api/automation/rules/${id}`, patch)
  return data.rule
}

export async function deleteAutomationRule(id: string): Promise<void> {
  await apiDelete(`/api/automation/rules/${id}`)
}

export async function runAutomationRuleNow(id: string): Promise<string> {
  const data = await apiPost<{ taskId: string }>(`/api/automation/rules/${id}/run`)
  return data.taskId
}
