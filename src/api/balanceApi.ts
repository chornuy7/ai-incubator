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
