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
  hasComments: boolean | null
  rating: number | null
  tgPeerId: string | null
  sources: string[]
  categoriesExtra: string[]
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

export async function refreshChannel(id: string): Promise<Channel> {
  const data = await apiPost<{ ok: boolean; channel: Channel }>(`/api/channels/${id}/refresh`)
  return data.channel
}

export async function deleteChannel(id: string): Promise<void> {
  await apiDelete(`/api/channels/${id}`)
}
