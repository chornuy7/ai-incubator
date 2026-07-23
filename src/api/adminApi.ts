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
  totals: { tasks: number; actions: number; tokens: number; coins: number }
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
