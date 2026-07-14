import { apiPost } from './client'

export interface CampaignModuleInput {
  moduleKey: string
  targets?: string[]
}

export interface CampaignLaunchInput {
  goalId?: string | null
  accountIds: string[]
  targets?: string[]
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
