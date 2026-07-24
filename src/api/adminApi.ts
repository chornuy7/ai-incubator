import { apiGet } from './client'

/** §5.3 (E1): свод для админ-панели. */
export interface AdminOverview {
  since: number
  accounts: { total: number; byStatus: Record<string, number>; resting: number; tired: number }
  tasks: { total: number; byStatus: Record<string, number>; byModule: Record<string, { tasks: number; done: number; actions: number }> }
  tokens: { tokens: number; coins: number; calls: number; byModule: Record<string, number>; byAccount: Record<string, number> }
  balance: { planId: string; plan: { name: string; accountLimit: number }; coins: number } | null
  /** Сумма монет по всем кошелькам пространства — то, что показывает панель. */
  coinTotal?: { coins: number; wallets: number }
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

export async function fetchClientReport(since?: number): Promise<ClientReport> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; report: ClientReport }>(`/api/admin/report${q}`)
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
  /** Монет на счету сейчас. */
  coins: number
  tasks: number
  actions: number
  /** Сколько списано за действия по его задачам. */
  spent: number
  tokens: number
  where: UserWhere[]
}
export interface UsersReport {
  since: number
  rows: UserRow[]
  totals: { coins: number; tasks: number; actions: number; spent: number; tokens: number }
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
  byAccount: Record<string, number>
}

export async function fetchProblems(since?: number): Promise<Problems> {
  const q = since ? `?since=${since}` : ''
  return (await apiGet<{ ok: boolean; problems: Problems }>(`/api/admin/problems${q}`)).problems
}

export async function fetchCrmOverview(): Promise<CrmOverview> {
  return (await apiGet<{ ok: boolean; crm: CrmOverview }>('/api/admin/crm')).crm
}

export async function fetchUsersReport(since?: number): Promise<UsersReport> {
  const q = since ? `?since=${since}` : ''
  const data = await apiGet<{ ok: boolean; report: UsersReport }>(`/api/admin/users-report${q}`)
  return data.report
}
