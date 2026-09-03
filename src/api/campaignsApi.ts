import { apiGet, apiPost, apiPut, apiDelete } from './client'

export interface CampaignModuleInput {
  moduleKey: string
  targets?: string[]
  /** Переопределение настроек конкретного модуля (перекрывает общие `settings` кампании). */
  settings?: Record<string, unknown>
}

export interface CampaignLaunchInput {
  goalId?: string | null
  /** Id сохранённой кампании (cmp_) — лиды и токены привязываются к ней в CRM/статистике. */
  campaignId?: string | null
  accountIds: string[]
  targets?: string[]
  settings?: Record<string, unknown> // общие лимиты/задержки кампании (прокидываются в модули)
  modules: CampaignModuleInput[]
  initiator?: string
  /** Дедлайн и дожим кампании — доезжают до воркеров в настройках задачи. */
  deadline?: string | null
  followUp?: CampaignFollowUp | null
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
  /** A3.2: какой агент ведёт каждый модуль кампании (moduleKey → agentId). */
  moduleAgents?: Record<string, string>
  /** Шаблон (настройки) каждого модуля кампании отдельно (moduleKey → settings). */
  moduleSettings?: Record<string, Record<string, unknown>>
  /** Свои цели у модуля (moduleKey → цели). Рассылке — получатели-номера/юзернеймы, а не общие каналы. */
  moduleTargets?: Record<string, string[]>
  /** §9.0: собственные целевые каналы кампании (нормализованы: без @, нижний регистр). */
  targets?: string[]
  pinned: boolean
  status: CampaignStatus
  chat?: CampaignChat
  /**
   * Дожим: писать ли, если человек ответил после закрытия диалога.
   * Переехал из агента (24.07) — агент отвечает за манеру речи, а «дожимать или
   * отпустить» это решение о ходе работы, и принимает его тот, кто знает цель и этап.
   */
  followUp?: CampaignFollowUp
  /** Срок этапа. Переехал из цели (24.07): цель бессрочна, укладывается кампания. */
  deadline?: string | null
  createdAt: number
  updatedAt: number
}

export interface CampaignFollowUp {
  enabled: boolean
  /** Сколько сообщений подряд можно дожимать одного человека. */
  limit: number
  /** Свободные указания ИИ на время дожима (необязательно). */
  instructions: string
}

export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

export interface CampaignInput {
  name: string
  goalId?: string | null
  modules?: string[]
  moduleKey: string
  moduleAgents?: Record<string, string>
  moduleSettings?: Record<string, Record<string, unknown>>
  moduleTargets?: Record<string, string[]>
  settings?: Record<string, unknown>
  accountIds?: string[]
  pinned?: boolean
  status?: CampaignStatus
  chat?: CampaignChat
  targets?: string[]
  deadline?: string | null
  followUp?: CampaignFollowUp | null
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

/** D5 (SPEC §2.4): что система поняла из намерения, написанного словами. */
export interface IntentSuggestion {
  modules: { moduleKey: string; why: string }[]
  targets: string[]
  result: { amount: number; unit: string } | null
  needsLink: boolean
  warnings: string[]
  understood: boolean
}

/**
 * Разобрать намерение. Заказчик: «я хочу создать кампанию, а не настроить модуль».
 * Возвращает ПРЕДЛОЖЕНИЕ — оператор видит, что понято, и правит.
 */
export async function parseIntent(text: string): Promise<IntentSuggestion> {
  const data = await apiPost<{ ok: boolean; suggestion: IntentSuggestion }>('/api/campaigns/intent', { text })
  return data.suggestion
}
