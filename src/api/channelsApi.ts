import { apiGet, apiPost, apiDelete, apiPut } from './client'

export interface Channel {
  id: string
  title: string
  link: string
  username: string
  category: string
  language: string
  region: string
  subscribers: number
  activity: number | null
  activityLabel?: 'high' | 'medium' | 'low' | 'stale' | null // 2-й проход: свежесть контента
  lastPostAt?: number | null
  er?: number | null // §6 (B1): вовлечённость (реакции+комменты)/просмотры
  avgViews?: number | null
  hasComments: boolean | null
  rating: number | null
  tgPeerId: string | null
  sources: string[]
  categoriesExtra: string[]
  botInGroup: boolean
  lastStatsAt: number | null
  statsBy: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Рейтинг канала ★/10 (§3.8, B1 · §6-решение): ПРИОРИТЕТ — вовлечённость (ER), НЕ голые
 * подписчики. Формула: нормализованные подписчики (не доминируют) + ER + открытые комменты.
 * Если ER ещё не посчитан (нет 2-го прохода) — fallback на метку свежести activityLabel.
 * ER = (реакции+комментарии)/просмотры; ~4%+ = отличная вовлечённость (полный бонус).
 */
export function channelRating(c: Pick<Channel, 'subscribers' | 'activityLabel' | 'hasComments' | 'er'>): number {
  const subs = c.subscribers || 0
  // База по подписчикам занижена, чтобы не доминировать над ER (§6: приоритет вовлечённости).
  const base = subs >= 100000 ? 5 : subs >= 10000 ? 4 : subs >= 1000 ? 3 : subs >= 100 ? 2 : 1
  let engagement: number
  if (typeof c.er === 'number' && c.er >= 0) {
    engagement = Math.min(4, c.er * 100) // ER 4% → +4 (приоритетный сигнал)
  } else {
    const act = c.activityLabel // fallback: свежесть контента
    engagement = act === 'high' ? 3 : act === 'medium' ? 2 : act === 'low' ? 1 : act === 'stale' ? -1 : 0
  }
  const commentsBonus = c.hasComments ? 1 : 0
  return Math.max(1, Math.min(10, Math.round(base + engagement + commentsBonus)))
}

export async function fetchChannels(): Promise<Channel[]> {
  const data = await apiGet<{ ok: boolean; channels: Channel[] }>('/api/channels')
  return data.channels
}

export async function upsertChannel(input: Partial<Channel> & { source?: string }): Promise<Channel> {
  const data = await apiPost<{ ok: boolean; channel: Channel }>('/api/channels', input)
  return data.channel
}

export async function updateChannel(id: string, patch: Partial<Channel>): Promise<Channel> {
  const data = await apiPut<{ ok: boolean; channel: Channel }>(`/api/channels/${id}`, patch)
  return data.channel
}

export async function refreshChannel(id: string): Promise<Channel> {
  const data = await apiPost<{ ok: boolean; channel: Channel }>(`/api/channels/${id}/refresh`)
  return data.channel
}

export async function deleteChannel(id: string): Promise<void> {
  await apiDelete(`/api/channels/${id}`)
}
