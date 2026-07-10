import { apiGet, apiPost, apiDelete } from './client'

export type TgstatImportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TgstatOptionItem { slug: string; label: string }
export interface TgstatOptions {
  categories: TgstatOptionItem[]
  regions: TgstatOptionItem[]
  catalog_items_per_step: number
  catalog_url_pattern: string
}

export interface TgstatSession {
  status: 'none' | 'active' | 'expired' | 'error'
  has_session: boolean
  telegram_logged_in: boolean
  cookie_count: number
  last_verified_at: string | null
  error_msg: string | null
  cookie_summary?: string
}

export interface TgstatImport {
  id: number
  category: string
  region: string | null
  max_pages: number
  min_subscribers: number
  status: TgstatImportStatus
  total_found: number
  pages_processed: number
  error_msg: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface TgstatChat {
  id: number
  import_id: number
  chat_name: string
  chat_username: string | null
  chat_link: string
  subscribers: number
  category: string | null
  region: string | null
  category_code: string | null
  source_tgstat_url: string
}

export interface TgstatVerifyResult { ok: boolean; message: string; status: string }

const base = '/api/tgstat'

export async function fetchTgstatOptions() {
  return (await apiGet<{ options: TgstatOptions }>(`${base}/options`)).options
}
export async function fetchTgstatSession() {
  return (await apiGet<{ session: TgstatSession }>(`${base}/session`)).session
}
export async function uploadTgstatSession(storageState: unknown) {
  return (await apiPost<{ session: TgstatSession }>(`${base}/session/upload`, { storage_state: storageState })).session
}
export async function verifyTgstatSession(region?: string) {
  const q = region ? `?region=${encodeURIComponent(region)}` : ''
  return (await apiPost<{ result: TgstatVerifyResult }>(`${base}/session/verify${q}`)).result
}
export async function clearTgstatSession() {
  return (await apiDelete<{ session: TgstatSession }>(`${base}/session`)).session
}
export async function fetchTgstatImports() {
  return (await apiGet<{ imports: TgstatImport[] }>(`${base}/imports`)).imports
}
export async function createTgstatImport(payload: { category: string; region: string | null; max_pages: number; min_subscribers: number }) {
  return (await apiPost<{ import: TgstatImport }>(`${base}/imports`, payload)).import
}
export async function fetchTgstatChats(id: number, minSubscribers = 0) {
  const q = minSubscribers ? `?min_subscribers=${minSubscribers}` : ''
  return (await apiGet<{ chats: TgstatChat[] }>(`${base}/imports/${id}/chats${q}`)).chats
}
export async function cancelTgstatImport(id: number) {
  return (await apiPost<{ import: TgstatImport }>(`${base}/imports/${id}/cancel`)).import
}
export async function deleteTgstatImport(id: number) {
  return apiDelete(`${base}/imports/${id}`)
}
export function tgstatExportUrl(id: number) {
  return `${base}/imports/${id}/export.csv`
}

export interface TgstatSearchFilters {
  q?: string; inAbout?: boolean
  categories?: string[]
  participantsCountFrom?: number; participantsCountTo?: number
  avgReachFrom?: number; avgReachTo?: number
  er?: number; err?: number; ciFrom?: number; ciTo?: number
  age?: number; male?: number; female?: number
  isVerified?: boolean; isStoriesAvailable?: boolean; isRknVerified?: boolean
  noRedLabel?: boolean; noScam?: boolean; noDead?: boolean
  sort?: string
}

/** Расширенный поиск каналов TGStat с фильтрами (охват/ER/ИЦ/аудитория). */
export async function searchTgstatChannels(filters: TgstatSearchFilters, maxPages = 3) {
  return (await apiPost<{ chats: TgstatChat[] }>(`${base}/search`, { filters, maxPages })).chats
}

export interface TgstatTarget { username: string; title: string; subscribers: number; link: string }

/** Синхронно вытянуть каналы/группы из каталога TGStat как список целей. */
export async function fetchTgstatTargets(payload: { category: string; region: string | null; minSubscribers?: number; maxPages?: number; limit?: number }) {
  return (await apiPost<{ targets: TgstatTarget[] }>(`${base}/targets`, payload)).targets
}
