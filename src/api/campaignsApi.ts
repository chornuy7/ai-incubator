import { apiGet, apiPost, apiPut, apiDelete } from './client'

export interface CampaignModuleInput {
  moduleKey: string
  targets?: string[]
}

export interface CampaignLaunchInput {
  goalId?: string | null
  accountIds: string[]
  targets?: string[]
  settings?: Record<string, unknown> // общие лимиты/задержки кампании (прокидываются в модули)
  modules: CampaignModuleInput[]
  initiator?: string
}

export interface CampaignResult {
  ok: boolean
  campaignId: string
  tasks: { moduleKey: string; taskId: string; accounts: number }[]
  skipped: { moduleKey: string; reason: string }[]
}

export async function launchCampaign(input: CampaignLaunchInput): Promise<CampaignResult> {
  return apiPost<CampaignResult>('/api/campaigns/launch', input)
}

// ── Расписание кампаний (§3.9) ──
export interface CampaignSchedule {
  id: string
  name: string
  body: CampaignLaunchInput
  runAt: number
  repeat: 'none' | 'daily'
  enabled: boolean
  lastRunAt: number | null
  lastResult: { campaignId: string | null; tasks: number; error: string | null } | null
  createdAt: number
  updatedAt: number
}

export async function fetchSchedules(): Promise<CampaignSchedule[]> {
  const data = await apiGet<{ schedules: CampaignSchedule[] }>('/api/campaigns/schedules')
  return data.schedules
}
export async function createSchedule(input: { name?: string; body: CampaignLaunchInput; runAt: number; repeat: 'none' | 'daily'; enabled?: boolean }): Promise<CampaignSchedule> {
  const data = await apiPost<{ schedule: CampaignSchedule }>('/api/campaigns/schedules', input)
  return data.schedule
}
export async function updateSchedule(id: string, patch: Partial<Pick<CampaignSchedule, 'name' | 'enabled' | 'runAt' | 'repeat'>>): Promise<CampaignSchedule> {
  const data = await apiPut<{ schedule: CampaignSchedule }>(`/api/campaigns/schedules/${id}`, patch)
  return data.schedule
}
export async function deleteSchedule(id: string): Promise<void> {
  await apiDelete(`/api/campaigns/schedules/${id}`)
}
