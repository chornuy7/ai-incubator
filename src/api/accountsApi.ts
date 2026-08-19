import type { TgAccount, AccountStatus, AccountStats, AccountChannel, AccountFolder } from '@/shared/types'
import { apiGet, apiPost, apiPatch, apiDelete } from './client'

export type ServerAccount = TgAccount

// ВАЖНО (bugfix): все запросы аккаунтов идут через apiGet/apiPost/apiPatch/apiDelete —
// они ставят заголовки авторизации (X-User-Id + Bearer). Голый fetch их НЕ ставил, и при
// включённой авторизации (есть SESSION_SECRET) сервер отвечал 401 «Требуется вход» —
// менеджер аккаунтов не загружался. Баланс/настройки работали, т.к. уже шли через клиент.

export async function fetchAccounts(): Promise<ServerAccount[]> {
  const data = await apiGet<{ accounts: ServerAccount[] }>('/api/tg/accounts')
  return data.accounts
}

export type AccountBusyMap = Record<string, { moduleKey: string; taskId: string; moduleLabel: string; taskStatus?: string }>

export async function fetchAccountBusy(): Promise<AccountBusyMap> {
  const data = await apiGet<{ busy?: AccountBusyMap }>('/api/tg/accounts/busy')
  return data.busy ?? {}
}

export async function patchAccount(
  accountId: string,
  patch: Partial<Pick<TgAccount, 'role' | 'project' | 'country' | 'status' | 'proxy' | 'inTrash' | 'note'>> & { initiator?: string },
) {
  return apiPatch<{ ok: boolean }>(`/api/tg/accounts/${accountId}`, patch)
}

export async function deleteAccount(accountId: string) {
  return apiDelete<{ ok: boolean }>(`/api/tg/accounts/${accountId}`)
}

export async function emptyTrashApi() {
  return apiPost<{ ok: boolean; count: number }>('/api/tg/accounts/empty-trash')
}

export async function patchAccountStatus(accountId: string, status: AccountStatus) {
  return patchAccount(accountId, { status })
}

/**
 * Статистика аккаунта. По умолчанию — СОХРАНЁННЫЙ вердикт (мгновенно, без сети).
 * `force` — живая перепроверка по кнопке «Проверить».
 */
export async function fetchAccountStats(accountId: string, opts?: { spam?: boolean; force?: boolean }): Promise<AccountStats> {
  const qs = opts?.spam ? '?spam=1' : opts?.force ? '?force=1' : ''
  const data = await apiGet<{ stats: AccountStats }>(`/api/tg/accounts/${accountId}/stats${qs}`)
  return data.stats
}

export async function fetchAccountChannels(accountId: string): Promise<{ busy: boolean; channels: AccountChannel[]; error?: string; busyIn?: { moduleLabel: string } }> {
  return apiGet(`/api/tg/accounts/${accountId}/channels`)
}

/** MR-164: одно сообщение канала/группы для просмотра переписки из карточки. */
export interface ChannelMessage { id: number; text: string; date: number; out: boolean; hasMedia: boolean; sender: string }

/** MR-164: последние сообщения канала/группы аккаунта (живой Telegram-запрос через сессию). */
export async function fetchAccountChannelMessages(accountId: string, peer: string): Promise<{ busy?: boolean; title?: string; messages: ChannelMessage[]; error?: string }> {
  return apiGet(`/api/tg/accounts/${accountId}/channel-messages?peer=${encodeURIComponent(peer)}`)
}

/** MR-129: аккаунт выходит из канала/группы (по id из списка каналов). */
export async function leaveAccountChannel(accountId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost<{ ok: boolean; error?: string }>(`/api/tg/accounts/${accountId}/channels/${channelId}/leave`, {})
}

export type DailyActionItem = { action: 'comments' | 'dm' | 'joins' | 'reactions'; used: number; cap: number; reached: boolean }
export type AccountDaily = { accountId: string; date: string; items: DailyActionItem[] }

/** Суточные счётчики действий аккаунта против потолков (§6) — для вкладки «Здоровье». */
export async function fetchAccountDaily(accountId: string): Promise<AccountDaily> {
  const data = await apiGet<{ daily: AccountDaily }>(`/api/tg/accounts/${accountId}/daily`)
  return data.daily
}

export type DailyAllEntry = { items: DailyActionItem[]; anyReached: boolean }
export type DailyAllMap = Record<string, DailyAllEntry>

/** Сводка §6 по всем активным сегодня аккаунтам — для индикатора throttle в списке. */
export async function fetchDailyAll(): Promise<DailyAllMap> {
  const data = await apiGet<{ daily?: DailyAllMap }>('/api/tg/accounts/daily-all')
  return data.daily ?? {}
}

export async function fetchAccountFolders(accountId: string): Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }> {
  return apiGet(`/api/tg/accounts/${accountId}/folders`)
}

export async function releaseAccountLock(accountId: string): Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }> {
  return apiPost(`/api/tg/accounts/${accountId}/release`)
}

/** Ручная смена статуса оператором (пауза/снятие) через state machine + аудит. */
export async function setAccountStatusManual(accountId: string, to: 'pause' | 'active', initiator?: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost(`/api/tg/accounts/${accountId}/status`, { to, initiator })
}

export async function reconcileLocks(): Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }> {
  return apiPost('/api/modules/locks/reconcile')
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
  const r = await apiGet<{ ok: boolean; work: AccountWork }>(`/api/accounts/${accountId}/work${q}`)
  return r.work
}

/** LOG-002/003: одно действие аккаунта из журнала (docs/CONTRACT-action-log). */
export type AccountActionType = 'post' | 'comment' | 'reaction' | 'chat' | 'dialog' | 'dm' | 'join' | 'action'
export interface AccountAction {
  id: string
  ts: string
  type: AccountActionType
  status: string
  accountId: string
  accountName: string
  target: string
  targetTitle: string
  objectRef: { postId?: number; url?: string; replyToId?: number | null }
  value: { text?: string; emoji?: string; kind?: string }
  moduleKey: string
  taskId: string
  launchId: string
  goalId: string
  audience: { repliesCount?: number; reactionsCount?: number; reactions?: Record<string, number>; replies?: unknown[] }
}

/** История действий аккаунта (MR-122). Фильтры: тип, группа/канал, период. */
export async function fetchAccountActions(
  accountId: string,
  filter?: { type?: string; target?: string; since?: number; until?: number; limit?: number },
): Promise<AccountAction[]> {
  const p = new URLSearchParams()
  if (filter?.type) p.set('type', filter.type)
  if (filter?.target) p.set('target', filter.target)
  if (filter?.since) p.set('since', String(filter.since))
  if (filter?.until) p.set('until', String(filter.until))
  if (filter?.limit) p.set('limit', String(filter.limit))
  const qs = p.toString() ? `?${p.toString()}` : ''
  const r = await apiGet<{ ok: boolean; actions: AccountAction[] }>(`/api/accounts/${accountId}/actions${qs}`)
  return r.actions || []
}
