import type { TgAccount, AccountStatus, AccountStats, AccountChannel, AccountFolder } from '@/shared/types'

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

export type AccountBusyMap = Record<string, { moduleKey: string; taskId: string; moduleLabel: string }>

export async function fetchAccountBusy(): Promise<AccountBusyMap> {
  const res = await fetch('/api/tg/accounts/busy')
  const data = await parseJson(res)
  return (data.busy ?? {}) as AccountBusyMap
}

export async function patchAccount(
  accountId: string,
  patch: Partial<Pick<TgAccount, 'role' | 'project' | 'country' | 'status' | 'proxy' | 'inTrash' | 'note'>>,
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

export async function fetchAccountFolders(accountId: string): Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/folders`)
  return parseJson(res) as Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }>
}

export async function releaseAccountLock(accountId: string): Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }> {
  const res = await fetch(`/api/tg/accounts/${accountId}/release`, { method: 'POST' })
  return parseJson(res) as Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }>
}

export async function reconcileLocks(): Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }> {
  const res = await fetch('/api/modules/locks/reconcile', { method: 'POST' })
  return parseJson(res) as Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }>
}
