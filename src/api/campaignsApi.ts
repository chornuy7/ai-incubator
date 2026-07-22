import { apiGet, apiPost, apiPut, apiDelete } from './client'

export interface CampaignModuleInput {
  moduleKey: string
  targets?: string[]
  /** Переопределение настроек конкретного модуля (перекрывает общие `settings` кампании). */
  settings?: Record<string, unknown>
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

// ── §5: сущность «Кампания» (список, CRUD, закрепление аккаунтов) ──

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'done'
export const CAMPAIGN_STATUSES: CampaignStatus[] = ['draft', 'active', 'paused', 'done']

/**
 * §9: догоняющий чатинг кампании. Основной модуль приводит людей, чатинг ведёт
 * с ответившими переписку к цели. Выключен по умолчанию — старые кампании не меняются.
 */
export interface CampaignChat {
  enabled: boolean
  settings: {
    dialogGoal?: string
    replyScope?: 'unread' | 'all'
    replyLimitMode?: 'untilTarget' | 'count'
    maxRepliesPerLead?: number
    maxActiveDialogs?: number
  }
}

export interface Campaign {
  id: string
  name: string
  goalId: string | null
  /** Первый модуль — для старых мест, которые ждут одиночное поле. */
  moduleKey: string
  /** Модули кампании: работают вместе на общем пуле аккаунтов. */
  modules: string[]
  settings: Record<string, unknown>
  accountIds: string[]
  pinned: boolean
  status: CampaignStatus
  chat?: CampaignChat
  createdAt: number
  updatedAt: number
}

export interface CampaignInput {
  name: string
  goalId?: string | null
  modules?: string[]
  moduleKey: string
  settings?: Record<string, unknown>
  accountIds?: string[]
  pinned?: boolean
  status?: CampaignStatus
  chat?: CampaignChat
}

/** Карта «аккаунт → кампания, которая его закрепила». */
export type PinnedMap = Record<string, { campaignId: string; name: string }>

export async function fetchCampaigns(filter: { goalId?: string; status?: CampaignStatus; moduleKey?: string } = {}): Promise<{ campaigns: Campaign[]; pinned: PinnedMap }> {
  const params = Object.fromEntries(Object.entries(filter).filter(([, v]) => v != null && v !== ''))
  const qs = new URLSearchParams(params as Record<string, string>).toString()
  const data = await apiGet<{ ok: boolean; campaigns: Campaign[]; pinned: PinnedMap }>(`/api/campaigns${qs ? `?${qs}` : ''}`)
  return { campaigns: data.campaigns, pinned: data.pinned || {} }
}

export async function createCampaign(input: CampaignInput): Promise<Campaign> {
  const data = await apiPost<{ ok: boolean; campaign: Campaign }>('/api/campaigns', input)
  return data.campaign
}

export async function updateCampaign(id: string, patch: Partial<CampaignInput>): Promise<Campaign> {
  const data = await apiPut<{ ok: boolean; campaign: Campaign }>(`/api/campaigns/${id}`, patch)
  return data.campaign
}

export async function deleteCampaign(id: string): Promise<void> {
  await apiDelete(`/api/campaigns/${id}`)
}
