import { apiGet } from './client'

/**
 * §5.3: ЛИЧНАЯ статистика — своя работа и свои расходы, без чужих данных.
 * Зеркалит серверный myStats: активность по родам действий (маппинг модуль→род),
 * разрез «куда идёт работа», лента запусков и расход по дням — всё только по себе.
 */
export interface MyActivity { comments: number; reactions: number; messages: number; views: number; pm: number }
export interface MyWhere { moduleKey: string; title: string; tasks: number; actions: number; tokens: number; spent: number }
export interface MyDaily { day: string; comments: number; reactions: number; messages: number; actions: number; tokens: number; coins: number }
export interface MyLogItem { id: string; moduleKey: string; title: string; status: string; actions: number; spent: number; at: number; finishedAt: number; errors: number }

export interface MyStats {
  since: number
  /** Монет на своём счету сейчас. */
  coins: number
  /** §11.4: денежный остаток ($) — им платят за подписку и покупают токены. */
  usd?: number
  totals: { tasks: number; actions: number; spent: number; tokens: number }
  activity: MyActivity
  where: MyWhere[]
  daily: MyDaily[]
  log: MyLogItem[]
}

export async function fetchMyStats(since?: number): Promise<MyStats> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; stats: MyStats }>(`/api/me/stats${q}`)
  return data.stats
}
