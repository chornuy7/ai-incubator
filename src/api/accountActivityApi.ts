import { apiGet, apiPost } from './client'

/** §4 (D1/D3): состояние усталости одного аккаунта — общее для всех модулей. */
export interface AccountActivity {
  fatigue: number
  threshold: number
  restUntil: number
  actionsTotal: number
  resting: boolean
}

export type ActivityMap = Record<string, AccountActivity>

export async function fetchActivity(): Promise<ActivityMap> {
  const data = await apiGet<{ ok: boolean; activity: ActivityMap }>('/api/accounts/activity')
  return data.activity
}

/**
 * §4.5, прямой запрос владельца: задать профиль усталости СРАЗУ ПАЧКЕ аккаунтов,
 * отправить выделенных на отдых или сбросить накопленную усталость.
 */
export async function setActivity(patch: {
  accountIds: string[]
  profile?: { threshold?: number; recoveryPerHour?: number; restMinutes?: number }
  reset?: boolean
  restMinutes?: number
}): Promise<{ applied: number; activity: ActivityMap }> {
  return apiPost<{ ok: boolean; applied: number; activity: ActivityMap }>('/api/accounts/activity', patch)
}
