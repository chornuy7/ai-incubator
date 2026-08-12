import type { TgAccount, AccountStatus, AccountStats, AccountChannel, AccountFolder } from '@/shared/types'
import { apiGet, apiPost } from './client'

export type ServerAccount = TgAccount

async function parseJson(res: Response) {
  const data = await res.json()
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

export async function fetchAccounts(): Promise<ServerAccount[]> {
  const res = await fetch('/api/tg/accounts')
  const data = await parseJson(res)
  return data.accounts as ServerAccount[]
}

export type AccountBusyMap = Record<string, { moduleKey: string; taskId: string; moduleLabel: string; taskStatus?: string }>

export async function fetchAccountBusy(): Promise<AccountBusyMap> {
  const res = await fetch('/api/tg/accounts/busy')
  const data = await parseJson(res)
  return (data.busy ?? {}) as AccountBusyMap
}

export async function patchAccount(
  accountId: string,
  patch: Partial<Pick<TgAccount, 'role' | 'project' | 'country' | 'status' | 'proxy' | 'inTrash' | 'note'>> & { initiator?: string },
) {
  const res = await fetch(`/api/tg/accounts/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return parseJson(res)
}

export async function deleteAccount(accountId: string) {
  const res = await fetch(`/api/tg/accounts/${accountId}`, { method: 'DELETE' })
  return parseJson(res)
}

export async function emptyTrashApi() {
  const res = await fetch('/api/tg/accounts/empty-trash', { method: 'POST' })
  return parseJson(res) as Promise<{ ok: boolean; count: number }>
}

export async function patchAccountStatus(accountId: string, status: AccountStatus) {
  return patchAccount(accountId, { status })
}

export async function fetchAccountStats(accountId: string, opts?: { spam?: boolean }): Promise<AccountStats> {
  const qs = opts?.spam ? '?spam=1' : ''
  const res = await fetch(`/api/tg/accounts/${accountId}/stats${qs}`)
  const data = await parseJson(res)
  return data.stats as AccountStats
}

export async function fetchAccountChannels(accountId: string): Promise<{ busy: boolean; channels: AccountChannel[]; error?: string; busyIn?: { moduleLabel: string } }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/channels`)
  return parseJson(res) as Promise<{ busy: boolean; channels: AccountChannel[]; error?: string; busyIn?: { moduleLabel: string } }>
}

/** MR-129: аккаунт выходит из канала/группы (по id из списка каналов). */
export async function leaveAccountChannel(accountId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost<{ ok: boolean; error?: string }>(`/api/tg/accounts/${accountId}/channels/${channelId}/leave`, {})
}

export type DailyActionItem = { action: 'comments' | 'dm' | 'joins' | 'reactions'; used: number; cap: number; reached: boolean }
export type AccountDaily = { accountId: string; date: string; items: DailyActionItem[] }

/** Суточные счётчики действий аккаунта против потолков (§6) — для вкладки «Здоровье». */
export async function fetchAccountDaily(accountId: string): Promise<AccountDaily> {
  const res = await fetch(`/api/tg/accounts/${accountId}/daily`)
  const data = await parseJson(res)
  return data.daily as AccountDaily
}

export type DailyAllEntry = { items: DailyActionItem[]; anyReached: boolean }
export type DailyAllMap = Record<string, DailyAllEntry>

/** Сводка §6 по всем активным сегодня аккаунтам — для индикатора throttle в списке. */
export async function fetchDailyAll(): Promise<DailyAllMap> {
  const res = await fetch('/api/tg/accounts/daily-all')
  const data = await parseJson(res)
  return (data.daily ?? {}) as DailyAllMap
}

export async function fetchAccountFolders(accountId: string): Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/folders`)
  return parseJson(res) as Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }>
}

export async function releaseAccountLock(accountId: string): Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/release`, { method: 'POST' })
  return parseJson(res) as Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }>
}

/** Ручная смена статуса оператором (пауза/снятие) через state machine + аудит. */
export async function setAccountStatusManual(accountId: string, to: 'pause' | 'active', initiator?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, initiator }),
  })
  return parseJson(res) as Promise<{ ok: boolean; error?: string }>
}

export async function reconcileLocks(): Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }> {
  const res = await fetch('/api/modules/locks/reconcile', { method: 'POST' })
  return parseJson(res) as Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }>
}

/**
 * Что аккаунт нам принёс: задачи, действия, токены, деньги, лиды — по модулям.
 * Отдельно от профиля Telegram: тот отвечает «кто он», этот — «какая отдача».
 */
export interface AccountWorkModule { moduleKey: string; title: string; tasks: number; actions: number; tokens: number; spent: number }
export interface AccountWork {
  accountId: string
  tasks: number
  actions: number
  spent: number
  tokens: number
  tokenCoins: number
  totalCoins: number
  errors: number
  lastUsed: number
  leads: { total: number; active: number; target: number }
  byModule: AccountWorkModule[]
  recent: { id: string; moduleKey: string; title: string; status: string; at: number; actions: number }[]
}

export async function fetchAccountWork(accountId: string, since?: number): Promise<AccountWork> {
  const q = since ? `?since=${since}` : ''
  // Через apiGet, а не голым fetch: он ставит X-User-Id, без которого серверный
  // гейт не поймёт, кто спрашивает, и отдаст данные любому.
  const r = await apiGet<{ ok: boolean; work: AccountWork }>(`/api/accounts/${accountId}/work${q}`)
  return r.work
}
