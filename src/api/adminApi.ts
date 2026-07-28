import { apiGet, apiPatch, apiPost, apiDelete } from './client'

/** §5.3 (E1): свод для админ-панели. */
export interface AdminOverview {
  since: number
  accounts: { total: number; byStatus: Record<string, number>; resting: number; tired: number }
  tasks: { total: number; byStatus: Record<string, number>; byModule: Record<string, { tasks: number; done: number; actions: number }> }
  tokens: { tokens: number; coins: number; calls: number; byModule: Record<string, number>; byAccount: Record<string, number> }
  balance: { planId: string; plan: { name: string; accountLimit: number }; coins: number } | null
  /** Сумма монет по всем кошелькам пространства — то, что показывает панель. */
  coinTotal?: { coins: number; wallets: number; service?: number }
  users: { total: number; active: number }
  audit: { total: number; byAction: Record<string, number> }
}

/** §5.3 (E2): постатейный «инвойс» — строка на модуль, без мелочей. */
export interface ReportRow {
  /** Плата за действия (фикс по прайсу) и за токены ИИ — в счёте нужны обе. */
  actionCoins?: number
  tokenCoins?: number
  moduleKey: string
  title: string
  tasks: number
  completed: number
  actions: number
  tokens: number
  coins: number
}

export interface ClientReport {
  since: number
  until: number
  rows: ReportRow[]
  totals: { tasks: number; actions: number; tokens: number; coins: number; actionCoins?: number; tokenCoins?: number }
}

export async function fetchAdminOverview(since?: number): Promise<AdminOverview> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; overview: AdminOverview }>(`/api/admin/overview${q}`)
  return data.overview
}

export async function fetchClientReport(since?: number, userId?: string): Promise<ClientReport> {
  const p = new URLSearchParams()
  if (since) p.set('since', String(since))
  if (userId) p.set('userId', userId)
  const qs = p.toString()
  const data = await apiGet<{ ok: boolean; report: ClientReport }>(`/api/admin/report${qs ? `?${qs}` : ''}`)
  return data.report
}

/** §5.3: разрез статистики по людям — кто сколько запустил и сколько с него списано. */
/** Разрез «куда»: что человек делал в конкретном модуле. */
export interface UserWhere { moduleKey: string; title: string; tasks: number; actions: number; tokens: number; spent: number }
export interface UserRow {
  userId: string
  email: string
  name: string
  active: boolean
  /** §10.4: под каким админом вложен этот суб-юзер (null — верхнеуровневый). */
  parentId?: string | null
  parentName?: string | null
  /** §10.4: роль(и) юзера читаемым именем (для бейджа на карточке). */
  roleName?: string | null
  /** §10.4: id ролей юзера — для назначения ролей из админки. */
  roleIds?: string[]
  /** Монет на счету сейчас. */
  coins: number
  /** Подписка: какие модули открыты. all=true — набор не выбран (открыто всё). null — синтетическая строка. */
  subscription: { all: boolean; count: number; titles: string[]; keys: string[] } | null
  tasks: number
  actions: number
  /** Сколько списано за действия по его задачам. */
  spent: number
  tokens: number
  where: UserWhere[]
  /** Сами запуски с датами: на «что он делал в среду» сумма за период не отвечает. */
  log: { id: string; moduleKey: string; title: string; status: string; actions: number; spent: number; at: number; finishedAt: number; errors: number }[]
}
export interface UsersReport {
  since: number
  rows: UserRow[]
  totals: { coins: number; tasks: number; actions: number; spent: number; tokens: number }
  /** §10.4: курс монета→$ для показа баланса юзера в долларах. 0 = нет прайса. */
  coinUsd?: number
}

/** §5.3: где сейчас болит. */
export interface FailedTask { id: string; moduleKey: string; title: string; status: string; errors: number; lastError: string; userId: string }
export interface Problems {
  since: number
  failedTasks: FailedTask[]
  failedTotal: number
  pausedNoCoins: { id: string; moduleKey: string; title: string; userId: string }[]
  accounts: { banned: number; flood: number; noProxy: number; bannedIds: { id: string; status: string }[]; floodIds: { id: string; status: string; until: number }[] }
}

/** §5.3 + CRM: воронка лидов. */
export interface CrmOverview {
  total: number
  byStatus: Record<string, number>
  hot: number
  stuck: number
  stuckDays: number
  target: number
  conversion: number
  /** Кто ведёт лидов — аккаунт-исполнитель, именем а не id. */
  owners: { accountId: string; name: string; count: number }[]
}

/** §5.3: что идёт прямо сейчас. */
export interface ActiveTask {
  id: string; moduleKey: string; title: string; status: string; userId: string
  done: number; total: number; percent: number; accounts: number
  startedAt: number; updatedAt: number; spentCoins: number; pausedByCoins: boolean
}
export interface ActiveNow { running: ActiveTask[]; paused: ActiveTask[] }

/** §5.3: расход по дням. */
export interface DailyRow { day: string; tokens: number; tokenCoins: number; actionCoins: number; coins: number; tasks: number; actions: number }
export interface DailySpend { days: number; rows: DailyRow[] }

export async function fetchActiveNow(): Promise<ActiveNow> {
  return (await apiGet<{ ok: boolean; active: ActiveNow }>('/api/admin/active')).active
}

export async function fetchDailySpend(days = 30): Promise<DailySpend> {
  return (await apiGet<{ ok: boolean; daily: DailySpend }>(`/api/admin/daily?days=${days}`)).daily
}

export async function fetchProblems(since?: number): Promise<Problems> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; problems: Problems }>(`/api/admin/problems${q}`)).problems
}

export async function fetchCrmOverview(since?: number): Promise<CrmOverview> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; crm: CrmOverview }>(`/api/admin/crm${q}`)).crm
}

/** §10.9: здоровье аккаунтов — активные/на паузе/падающие + причина по каждому. */
export interface AccountProblem {
  id: string; name: string; phone: string; status: string; statusLabel: string
  reason: string; since: number; until: number
}
export interface AccountsHealth {
  total: number; healthy: number; idle: number; problem: number; resting: number; tired: number
  byStatus: Record<string, number>
  problems: AccountProblem[]
}
export async function fetchAccountsHealth(): Promise<AccountsHealth> {
  return (await apiGet<{ ok: boolean; health: AccountsHealth }>('/api/admin/accounts-health')).health
}

export async function fetchUsersReport(since?: number): Promise<UsersReport> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; report: UsersReport }>(`/api/admin/users-report${q}`)
  return data.report
}

/** §5.3: что и сколько куплено — пополнения кошельков по людям (только админ). */
export interface PurchaseUser { userId: string; name: string; email: string; count: number; coins: number; lastAt: number }
export interface PurchaseFeedItem { ts: number; userId: string; name: string; email: string; amount: number; reason: string }
/** Покупка/продление плана ($): modulesCount = -1 означает «все модули». */
export interface PlanPurchase { ts: number; userId: string; name: string; email: string; amount: number; modulesCount: number; reason: string }
export interface Purchases {
  since: number
  /** Всего начислено монет за период по всем кошелькам. */
  boughtTotal: number
  count: number
  rows: PurchaseUser[]
  feed: PurchaseFeedItem[]
  /** Покупки планов/подписок ($) — отдельный от монет поток. */
  plans: { currency: string; total: number; count: number; feed: PlanPurchase[] }
}

export async function fetchPurchases(since?: number): Promise<Purchases> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; purchases: Purchases }>(`/api/admin/purchases${q}`)
  return data.purchases
}

/** §5.1: строка из базы оплат (SQLite-индекс). kind: 'coins' (⚡) | 'plan' ($). */
export interface PaymentRow {
  id: string; ts: number; user_id: string; kind: 'coins' | 'plan'
  coins: number | null; amount_fiat: number | null; currency: string
  modules: number | null; status: string; reason: string
  name: string; email: string
}
export interface PaymentsResult {
  total: number; limit: number; offset: number
  items: PaymentRow[]
  summary: { coinsTotal: number; coinsCount: number; planTotal: number; planCount: number }
  /** §10.4: курс монета→$ (для показа $-эквивалента пополнений). 0 = нет прайса. */
  coinUsd?: number
}
export interface PaymentsQuery { from?: number; to?: number; userId?: string; kind?: string; q?: string; limit?: number; offset?: number }

/** База оплат с диапазоном дат и пагинацией — «найти покупку за месяц назад». */
export async function fetchPayments(opts: PaymentsQuery = {}): Promise<PaymentsResult> {
  const p = new URLSearchParams()
  if (opts.from) p.set('from', String(opts.from))
  if (opts.to) p.set('to', String(opts.to))
  if (opts.userId) p.set('userId', opts.userId)
  if (opts.kind) p.set('kind', opts.kind)
  if (opts.q) p.set('q', opts.q)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  const data = await apiGet<{ ok: boolean; payments: PaymentsResult }>(`/api/admin/payments?${p.toString()}`)
  return data.payments
}

/** §10.4: цены из БД — эффективные значения + пометка «изменено». */
export interface PriceModule { key: string; title: string; month: number; action: number; overridden: { month: boolean; action: boolean } }
export interface EffectivePrices {
  modules: PriceModule[]
  monthMap: Record<string, number>
  actionMap: Record<string, number>
  coinPacks: { coins: number; price: number; best?: boolean }[]
  annualDiscount: number
  coinsPer1kTokens: number
  /** §10.1: себестоимость токена ($). Считается из модели, если админ не переопределил. */
  tokenUsd: number | null
  /** true — цена рассчитана автоматически из модели; false — задана вручную. */
  tokenUsdAuto?: boolean
  /** Всегда цена из модели (даже при ручном override) — для подсказки «авто». */
  tokenUsdComputed?: number | null
  /** Модель, из которой считается себестоимость (для подписи в админке). */
  tokenUsdModel?: string
  imageMultiplier: number
}

export async function fetchPrices(): Promise<EffectivePrices> {
  return (await apiGet<{ ok: boolean; prices: EffectivePrices }>('/api/admin/prices')).prices
}

export interface PricePatch {
  modules?: Record<string, { month?: number | string; action?: number | string }>
  annualDiscount?: number | string
  coinsPer1kTokens?: number | string
  tokenUsd?: number | string
  imageMultiplier?: number | string
  coinPacks?: { coins: number; price: number; best?: boolean }[]
}

export async function savePrices(patch: PricePatch): Promise<EffectivePrices> {
  return (await apiPatch<{ ok: boolean; prices: EffectivePrices }>('/api/admin/prices', patch)).prices
}

/** §10.3: API-ключи для внешнего AI-оркестратора. */
export interface ApiKeyInfo { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number; revoked: boolean }

export async function fetchApiKeys(): Promise<ApiKeyInfo[]> {
  return (await apiGet<{ ok: boolean; keys: ApiKeyInfo[] }>('/api/admin/api-keys')).keys
}
export async function issueApiKey(name: string): Promise<{ id: string; name: string; key: string; prefix: string }> {
  return (await apiPost<{ ok: boolean; key: { id: string; name: string; key: string; prefix: string } }>('/api/admin/api-keys', { name })).key
}
export async function revokeApiKey(id: string): Promise<void> {
  await apiDelete(`/api/admin/api-keys/${id}`)
}
