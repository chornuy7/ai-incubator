import { apiGet, apiPost, apiDelete } from './client'

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
 * Рейтинг канала ★/10 (§3.8, B1): приоритет — активность/вовлечённость, НЕ голые подписчики.
 * База по подписчикам + вес свежести контента (activityLabel из 2-го прохода) + открытые комменты.
 * Маленький активный канал обгоняет большой «мёртвый».
 */
export function channelRating(c: Pick<Channel, 'subscribers' | 'activityLabel' | 'hasComments'>): number {
  const subs = c.subscribers || 0
  const base = subs >= 100000 ? 6 : subs >= 10000 ? 5 : subs >= 1000 ? 4 : subs >= 100 ? 3 : 2
  const act = c.activityLabel
  const actBonus = act === 'high' ? 3 : act === 'medium' ? 2 : act === 'low' ? 1 : act === 'stale' ? -1 : 0
  const commentsBonus = c.hasComments ? 1 : 0
  return Math.max(1, Math.min(10, base + actBonus + commentsBonus))
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
  const res = await fetch(`/api/channels/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await res.json()
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data.channel
}

export async function refreshChannel(id: string): Promise<Channel> {
  const data = await apiPost<{ ok: boolean; channel: Channel }>(`/api/channels/${id}/refresh`)
  return data.channel
}

export async function deleteChannel(id: string): Promise<void> {
  await apiDelete(`/api/channels/${id}`)
}
