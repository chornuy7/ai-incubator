import { apiGet, apiPost } from './client'

/** §4 (D1/D3): состояние усталости одного аккаунта — общее для всех модулей. */
export interface AccountActivity {
  fatigue: number
  threshold: number
  restUntil: number
  actionsTotal: number
  resting: boolean
  /** Шанс привлечения в текущем часе, % — прямой ответ на «почему аккаунт молчит». */
  chanceNow?: number
  /** Распорядок задан вручную (иначе — личный, выведенный из id). */
  scheduleCustom?: boolean
}

/** Распорядок дня: час (0–23) → вероятность привлечения в ПРОЦЕНТАХ (0–100). */
export type SchedulePercent = Record<number, number>

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
  /** Часы в процентах (0–100). Сервер приводит к своему виду сам. */
  schedule?: SchedulePercent
  /** Раздать каждому свой сдвиг вокруг заданной кривой (по умолчанию да). */
  spread?: boolean
  reset?: boolean
  restMinutes?: number
}): Promise<{ applied: number; activity: ActivityMap }> {
  return apiPost<{ ok: boolean; applied: number; activity: ActivityMap }>('/api/accounts/activity', patch)
}
