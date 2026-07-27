import { apiGet, apiPost, apiDelete } from './client'

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
  /** Срок подписки: timestamp окончания или null («бессрочно» / демо без периода). */
  expiresAt?: number | null
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
  /** Пакеты пополнения — цена самой монеты. С сервера, не копией в вебе. */
  packs?: { coins: number; price: number; best?: boolean }[]
  currency?: string
  /** §10.5: наценка на анализ изображения (расход vision ×N). Из админки, не из кода. */
  imageMultiplier?: number
}
export async function fetchPricing(): Promise<Pricing> {
  const r = await apiGet<Pricing & { ok: boolean }>('/api/pricing')
  // Пробрасываем packs/currency — без них шапка всегда рисовала запасные пакеты,
  // игнорируя цены с сервера (и правки монет из админки).
  return {
    items: r.items || [], actions: r.actions || {}, avgTokens: r.avgTokens || {},
    coinsPer1kTokens: r.coinsPer1kTokens ?? 1, packs: r.packs, currency: r.currency,
    imageMultiplier: r.imageMultiplier,
  }
}

/** §5.4: подписка на модули — витрина и то, что уже куплено. */
export interface SubModule { key: string; title: string; price: number }
export interface SubCost { sum: number; full: number; setup: string | null; discount: number }
export interface SubSetup {
  id: string
  name: string
  hint: string
  modules: string[]
  discount: number
  cost: SubCost
  /** Набор, собранный админом: цена явная, удалить можно только его. */
  custom?: boolean
  price?: number
}
export interface Subscription { items: SubModule[]; setups: SubSetup[]; currency: string; mine: string[] | 'all'   /** Годовая скидка (эффективная, из админки). */
  annualDiscount?: number
}

export async function fetchSubscription(): Promise<Subscription> {
  const r = await apiGet<Subscription & { ok: boolean }>('/api/subscription')
  return { items: r.items || [], setups: r.setups || [], currency: r.currency || '$', mine: r.mine ?? 'all', annualDiscount: r.annualDiscount }
}

export async function quoteSubscription(modules: string[]): Promise<SubCost> {
  return apiPost<SubCost>('/api/subscription/quote', { modules })
}

/** Оформить подписку на набор. `months` — период (1 или 12); 0/пусто — без срока (демо). */
export async function saveSubscription(modules: string[] | 'all', months = 0): Promise<Balance> {
  const r = await apiPost<{ balance: Balance }>('/api/subscription', { modules, months })
  return r.balance
}

/** §10.4: админ выдаёт/снимает модули КОНКРЕТНОМУ юзеру (userId — admin-only на сервере). */
export async function saveUserModules(userId: string, modules: string[] | 'all'): Promise<Balance> {
  const r = await apiPost<{ balance: Balance }>('/api/subscription', { modules, userId })
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

/** §5.4: набор под клиента — админ выбирает модули и называет цену. */
export async function createBundle(input: { name: string; hint?: string; modules: string[]; price: number }): Promise<void> {
  await apiPost('/api/bundles', input)
}

export async function deleteBundle(id: string): Promise<void> {
  await apiDelete(`/api/bundles/${id}`)
}
