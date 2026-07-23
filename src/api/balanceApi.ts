import { apiGet, apiPost } from './client'

export interface Plan {
  name: string
  accountLimit: number
}

export interface Balance {
  planId: string
  plan: Plan
  /** Монеты с точностью до сотых — списание за действие это доли монеты (C2). */
  coins: number
  updatedAt: number
}

/** §5.1 (B2): баланс и тариф с сервера. До этого шапка показывала константу из моков. */
export async function fetchBalance(): Promise<Balance> {
  const data = await apiGet<{ ok: boolean; balance: Balance }>('/api/balance')
  return data.balance
}

/** Пополнить (amount > 0), списать (amount < 0) или сменить тариф. Только админ. */
export async function changeBalance(patch: { amount?: number; planId?: string; reason?: string }): Promise<Balance> {
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
