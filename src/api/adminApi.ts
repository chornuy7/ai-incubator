import { apiGet, apiPatch, apiDelete } from './client'

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

export async function fetchAdminOverview(since?: number, signal?: AbortSignal): Promise<AdminOverview> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; overview: AdminOverview }>(`/api/admin/overview${q}`, { signal })
  return data.overview
}

export async function fetchClientReport(since?: number, userId?: string, signal?: AbortSignal): Promise<ClientReport> {
  const p = new URLSearchParams()
  if (since) p.set('since', String(since))
  if (userId) p.set('userId', userId)
  const qs = p.toString()
  const data = await apiGet<{ ok: boolean; report: ClientReport }>(`/api/admin/report${qs ? `?${qs}` : ''}`, { signal })
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
  /** Монет (токенов) на счету сейчас. */
  coins: number
  /** §11.4: деньги ($) на счету — основной кошелёк, показывается прежде токенов. */
  usd: number
  /** §4.2 (MR-30): режим баланса суба — 'shared' (общий с владельцем) / 'individual' (свой лимит). */
  balanceMode?: 'shared' | 'individual'
  /** §11.9: последний вход — когда (ISO) и с какого IP. null — входов в аудите нет. */
  lastLogin?: { at: string; ip: string } | null
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
  totals: { coins: number; usd: number; tasks: number; actions: number; spent: number; tokens: number }
  /** §10.4: курс монета→$ для показа баланса юзера в долларах. 0 = нет прайса. */
  coinUsd?: number
}

/** §5.3: где сейчас болит. */
export interface FailedTask { id: string; moduleKey: string; title: string; status: string; errors: number; lastError: string; userId: string }
/** §5.2 (MR-34): постатейный ролл-ап по модулю — отчёт + статусы + ошибки в одной строке. */
export interface ProblemModule { key: string; title: string; tasks: number; done: number; running: number; errorTasks: number; errors: number }
export interface Problems {
  since: number
  taskStatus: Record<string, number>
  modules: ProblemModule[]
  failedTasks: FailedTask[]
  failedTotal: number
  pausedNoCoins: { id: string; moduleKey: string; title: string; userId: string }[]
  accounts: { banned: number; flood: number; noProxy: number; bannedIds: { id: string; status: string }[]; floodIds: { id: string; status: string; until: number }[] }
}
export interface TaskLogEntry { ts: number; level: string; account: string; message: string }
export interface TaskLogs { id: string; moduleKey: string; status: string; logs: TaskLogEntry[] }
/** §5.2 (MR-34): ленивые логи одной задачи — грузим при раскрытии строки ошибки. */
export async function fetchTaskLogs(moduleKey: string, id: string, signal?: AbortSignal): Promise<TaskLogs> {
  const q = `?module=${encodeURIComponent(moduleKey)}&id=${encodeURIComponent(id)}`
  return await apiGet<TaskLogs & { ok: boolean }>(`/api/admin/task-logs${q}`, { signal })
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
  /**
   * ПОЛНЫЙ список лидов всех пользователей: от кого пришёл, каким аккаунтом ведётся,
   * чей это юзер и из какой кампании — чтобы админ мог открыть переписку и разобрать
   * конкретный случай, а не только смотреть сводку.
   */
  rows: {
    id: string; peer: string; status: string; isHot: boolean
    accountId: string; accountName: string
    userId: string; userName: string
    campaignId: string; campaignName: string; goalId: string; taskId: string
    note: string; result: string
    createdAt: number; updatedAt: number
  }[]
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

export async function fetchActiveNow(signal?: AbortSignal): Promise<ActiveNow> {
  return (await apiGet<{ ok: boolean; active: ActiveNow }>('/api/admin/active', { signal })).active
}

export async function fetchDailySpend(days = 30, signal?: AbortSignal): Promise<DailySpend> {
  return (await apiGet<{ ok: boolean; daily: DailySpend }>(`/api/admin/daily?days=${days}`, { signal })).daily
}

// §3.3 (MR-23): экономика — доходы, расходы, маржа.
export interface EconomyModuleCost { key: string; title: string; tokens: number; costUsd: number }
export interface EconomyServer { name: string; accounts: number; aiCostUsd: number; costPerAccountUsd: number }
export interface Economy {
  since: number
  until: number
  currency: string
  income: {
    total: number
    plans: number; plansCount: number
    balanceTopups: number; balanceCount: number
    tokens: number; tokensCoins: number; tokensCount: number; coinUsd: number
  }
  expenses: {
    total: number
    ai: number; tokensSpent: number; tokenUsd: number
    tokenUsdAuto: boolean; tokenUsdModel: string
    byModule: EconomyModuleCost[]
  }
  margin: number
  marginPct: number
  servers: EconomyServer[]
}

export async function fetchEconomy(since?: number, signal?: AbortSignal): Promise<Economy> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; economy: Economy }>(`/api/admin/economy${q}`, { signal })).economy
}

export async function fetchProblems(since?: number, signal?: AbortSignal): Promise<Problems> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; problems: Problems }>(`/api/admin/problems${q}`, { signal })).problems
}

export async function fetchCrmOverview(since?: number, signal?: AbortSignal): Promise<CrmOverview> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; crm: CrmOverview }>(`/api/admin/crm${q}`, { signal })).crm
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
export async function fetchAccountsHealth(signal?: AbortSignal): Promise<AccountsHealth> {
  return (await apiGet<{ ok: boolean; health: AccountsHealth }>('/api/admin/accounts-health', { signal })).health
}

/** §10.9 (кол 29.07): нагрузка сервера сейчас — RPS и загрузка CPU/памяти. */
export interface SystemMetrics {
  rps1s: number; rps1m: number
  cpu: { procPct: number; load1: number; cores: number }
  mem: { rssMb: number; heapUsedMb: number; systemUsedPct: number; systemTotalMb: number }
  uptimeSec: number
}
export async function fetchSystemMetrics(): Promise<SystemMetrics> {
  return (await apiGet<{ ok: boolean; system: SystemMetrics }>('/api/admin/system')).system
}

/** §11.1: одна запись журнала активности юзера. bySelf=false — действие СДЕЛАЛИ над ним. */
export interface ActivityRow {
  ts: string; action: string; module: string; reason: string; ip: string; account: string; bySelf: boolean
}
export interface UserActivity {
  userId: string; email: string; total: number; rows: ActivityRow[]; actions: string[]
}
/** §11.1: журнал активности конкретного юзера — что делал, когда, с какого IP. */
export async function fetchUserActivity(userId: string, action = '', limit = 300): Promise<UserActivity> {
  const q = new URLSearchParams({ userId, limit: String(limit) })
  if (action) q.set('action', action)
  return (await apiGet<{ ok: boolean; activity: UserActivity }>(`/api/admin/user-activity?${q}`)).activity
}

/** §11.1: строка «с кем переписывается». viaOwner=false — связали через аккаунт из его задачи. */
export interface DialogRow {
  id: string; peer: string; accountId: string; accountName: string
  status: string; isHot: boolean; note: string; viaOwner: boolean; at: number
}
export interface UserDialogs { userId: string; rows: DialogRow[]; total: number; accounts: number }
/** §11.1: диалоги (лиды), которые ведут аккаунты этого юзера. */
export async function fetchUserDialogs(userId: string): Promise<UserDialogs> {
  return (await apiGet<{ ok: boolean; dialogs: UserDialogs }>(`/api/admin/user-dialogs?userId=${encodeURIComponent(userId)}`)).dialogs
}

/** §11.1: реплика переписки. direction: 'in' — написали нам, 'out' — написали мы. */
export interface MessageRow {
  id: string; accountId: string; userId: string; peer: string
  direction: 'in' | 'out'; text: string; moduleKey: string; taskId: string; at: number
}
/** §11.1: переписка — по собеседнику, аккаунту или юзеру целиком. Только админ. */
export async function fetchMessages(f: { userId?: string; accountId?: string; peer?: string; limit?: number }): Promise<MessageRow[]> {
  const q = new URLSearchParams()
  if (f.userId) q.set('userId', f.userId)
  if (f.accountId) q.set('accountId', f.accountId)
  if (f.peer) q.set('peer', f.peer)
  if (f.limit) q.set('limit', String(f.limit))
  return (await apiGet<{ ok: boolean; messages: MessageRow[] }>(`/api/admin/messages?${q}`)).messages
}

export async function fetchUsersReport(since?: number, signal?: AbortSignal): Promise<UsersReport> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; report: UsersReport }>(`/api/admin/users-report${q}`, { signal })
  return data.report
}

/** §5.3: что и сколько куплено — пополнения кошельков по людям (только админ). */
export interface PurchaseUser { userId: string; name: string; email: string; count: number; coins: number; lastAt: number }
export interface PurchaseFeedItem { ts: number; userId: string; name: string; email: string; amount: number; reason: string }
/** Покупка/продление плана ($): modulesCount = -1 означает «все модули». */
export interface PlanPurchase { ts: number; userId: string; name: string; email: string; amount: number; modulesCount: number; reason: string }
/** §11.4: денежное пополнение баланса ($) по человеку. */
export interface UsdTopUpUser { userId: string; name: string; email: string; count: number; usd: number; lastAt: number }
export interface Purchases {
  since: number
  /** Всего начислено монет за период по всем кошелькам. */
  boughtTotal: number
  count: number
  rows: PurchaseUser[]
  feed: PurchaseFeedItem[]
  /** Покупки планов/подписок ($) — отдельный от монет поток. */
  plans: { currency: string; total: number; count: number; feed: PlanPurchase[] }
  /** §11.4: пополнения баланса деньгами ($) — отдельно от токенов и планов. */
  usd?: { currency: string; total: number; count: number; rows: UsdTopUpUser[]; feed: PurchaseFeedItem[] }
}

export async function fetchPurchases(since?: number, signal?: AbortSignal): Promise<Purchases> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; purchases: Purchases }>(`/api/admin/purchases${q}`, { signal })
  return data.purchases
}

/** §5.1: строка из базы оплат (SQLite-индекс). kind: 'usd' (деньги $) | 'coins' (⚡) | 'plan' ($). */
export interface PaymentRow {
  id: string; ts: number; user_id: string; kind: 'usd' | 'coins' | 'plan'
  coins: number | null; amount_fiat: number | null; currency: string
  modules: number | null; status: string; reason: string
  name: string; email: string
}
export interface PaymentsResult {
  total: number; limit: number; offset: number
  items: PaymentRow[]
  summary: { coinsTotal: number; coinsCount: number; planTotal: number; planCount: number; usdTotal?: number; usdCount?: number }
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
export interface PriceModule { key: string; title: string; month: number; action: number; gift: number; overridden: { month: boolean; action: boolean; gift: boolean } }
export interface EffectivePrices {
  modules: PriceModule[]
  monthMap: Record<string, number>
  actionMap: Record<string, number>
  /** §3 (MR-21): подарочные токены на модуль (суммируются при выборе набора). */
  giftMap: Record<string, number>
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
  /** §11.2: периоды подписки со скидками — генерируемый список, не «месяц/год» в коде. */
  periods?: SubPeriod[]
}

/** §11.2: период подписки. discount — доля (0.2 = −20%). */
export interface SubPeriod { unit: 'week' | 'month' | 'year' | string; count: number; discount: number }

export async function fetchPrices(): Promise<EffectivePrices> {
  return (await apiGet<{ ok: boolean; prices: EffectivePrices }>('/api/admin/prices')).prices
}

export interface PricePatch {
  modules?: Record<string, { month?: number | string; action?: number | string; gift?: number | string }>
  annualDiscount?: number | string
  coinsPer1kTokens?: number | string
  tokenUsd?: number | string
  imageMultiplier?: number | string
  coinPacks?: { coins: number; price: number; best?: boolean }[]
  periods?: SubPeriod[]
}

export async function savePrices(patch: PricePatch): Promise<EffectivePrices> {
  return (await apiPatch<{ ok: boolean; prices: EffectivePrices }>('/api/admin/prices', patch)).prices
}

/** §10.3: API-ключи для внешнего AI-оркестратора. */
/** ownerId — для какого ПОЛЬЗОВАТЕЛЯ продукта выпущен ключ (users.id). */
export interface ApiKeyInfo { id: string; name: string; prefix: string; ownerId: string; createdAt: number; lastUsedAt: number; revoked: boolean }

export async function fetchApiKeys(): Promise<ApiKeyInfo[]> {
  return (await apiGet<{ ok: boolean; keys: ApiKeyInfo[] }>('/api/admin/api-keys')).keys
}
// §11.8: выпуск ключа под пользователя убран — «мозги» ходят сервисным env-ключом.
// Остаются список и отзыв (для гашения легаси-ключей).
export async function revokeApiKey(id: string): Promise<void> {
  await apiDelete(`/api/admin/api-keys/${id}`)
}
/** Задан ли сервисный ключ «мозгов» в окружении сервера (значение не отдаётся). */
export async function serviceKeyStatus(): Promise<{ configured: boolean }> {
  return apiGet('/api/admin/api-keys/service')
}
