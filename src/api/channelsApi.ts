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
