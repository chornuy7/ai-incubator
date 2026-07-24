import { apiGet, apiPost } from './client'

export interface Plan {
  name: string
  accountLimit: number
}

export interface Balance {
  planId: string
  plan: Plan
  /** §5.4: купленные модули. 'all' — набор ещё не выбирали, открыто всё. */
  modules: string[] | 'all'
  /** Монеты с точностью до ТЫСЯЧНЫХ: строка парсера стоит 0.005 (C2). */
  coins: number
  updatedAt: number
}

/** §5.1 (B2): баланс и тариф с сервера. До этого шапка показывала константу из моков. */
export async function fetchBalance(): Promise<Balance> {
  const data = await apiGet<{ ok: boolean; balance: Balance }>('/api/balance')
  return data.balance
}

/** Пополнить (amount > 0), списать (amount < 0) или сменить тариф. Только админ. */
/** `userId` — чей кошелёк править. Без него правится свой; чужой доступен только админу. */
export async function changeBalance(patch: { amount?: number; planId?: string; reason?: string; userId?: string }): Promise<Balance> {
  const data = await apiPost<{ ok: boolean; balance: Balance }>('/api/balance', patch)
  return data.balance
}

/** Прайс с сервера: цена действия по модулям + курс токенов. Витрина не должна расходиться с тем, что спишется. */
export interface PriceItem { key: string; title: string; price: number; avgTokens: number }
export interface Pricing {
  items: PriceItem[]
  actions: Record<string, number>
  /** Средний расход токенов на действие по своей истории. 0 = считать не на чем. */
  avgTokens: Record<string, number>
  coinsPer1kTokens: number
}
export async function fetchPricing(): Promise<Pricing> {
  const r = await apiGet<{ items?: PriceItem[]; actions?: Record<string, number>; avgTokens?: Record<string, number>; coinsPer1kTokens: number }>('/api/pricing')
  return { items: r.items || [], actions: r.actions || {}, avgTokens: r.avgTokens || {}, coinsPer1kTokens: r.coinsPer1kTokens ?? 1 }
}

/** §5.4: подписка на модули — витрина и то, что уже куплено. */
export interface SubModule { key: string; title: string; price: number }
export interface SubCost { sum: number; full: number; setup: string | null; discount: number }
export interface SubSetup { id: string; name: string; hint: string; modules: string[]; discount: number; cost: SubCost }
export interface Subscription { items: SubModule[]; setups: SubSetup[]; currency: string; mine: string[] | 'all' }

export async function fetchSubscription(): Promise<Subscription> {
  const r = await apiGet<Subscription & { ok: boolean }>('/api/subscription')
  return { items: r.items || [], setups: r.setups || [], currency: r.currency || '$', mine: r.mine ?? 'all' }
}

export async function quoteSubscription(modules: string[]): Promise<SubCost> {
  return apiPost<SubCost>('/api/subscription/quote', { modules })
}

/** Оформить подписку на набор. Оплаты в демо нет — набор записывается сразу. */
export async function saveSubscription(modules: string[] | 'all'): Promise<Balance> {
  const r = await apiPost<{ balance: Balance }>('/api/subscription', { modules })
  return r.balance
}

/** §5.1: операция по кошельку — «за что списали». */
export interface WalletEntry { ts: number; userId: string; amount: number; before: number; after: number; reason: string }

export async function fetchWalletHistory(limit = 50, userId?: string): Promise<WalletEntry[]> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (userId) q.set('userId', userId)
  const r = await apiGet<{ ok: boolean; rows: WalletEntry[] }>(`/api/balance/history?${q}`)
  return r.rows || []
}
