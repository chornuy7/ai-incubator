import { apiGet, apiPost, apiDelete, parseJson } from './client'

export type LeadStatus = 'cold' | 'answered' | 'hot' | 'target' | 'closed'
export const LEAD_STATUSES: LeadStatus[] = ['cold', 'answered', 'hot', 'target', 'closed']

export interface Lead {
  id: string
  goalId: string | null
  accountId: string | null
  peer: string
  status: LeadStatus
  result: string
  note: string
  isHot: boolean
  createdAt: number
  updatedAt: number
}

export interface LeadInput {
  peer: string
  goalId?: string | null
  accountId?: string | null
  status?: LeadStatus
  result?: string
  note?: string
}

export async function fetchLeads(filter: { goalId?: string; status?: LeadStatus } = {}): Promise<Lead[]> {
  const qs = new URLSearchParams(filter as Record<string, string>).toString()
  const data = await apiGet<{ ok: boolean; leads: Lead[] }>(`/api/leads${qs ? `?${qs}` : ''}`)
  return data.leads
}

export async function fetchLeadStats(goalId?: string): Promise<{ total: number; byStatus: Record<LeadStatus, number> }> {
  const qs = goalId ? `?goalId=${encodeURIComponent(goalId)}` : ''
  const data = await apiGet<{ ok: boolean; stats: { total: number; byStatus: Record<LeadStatus, number> } }>(`/api/leads/stats${qs}`)
  return data.stats
}

export async function createLead(input: LeadInput): Promise<Lead> {
  const data = await apiPost<{ ok: boolean; lead: Lead }>('/api/leads', input)
  return data.lead
}

export async function updateLead(id: string, patch: Partial<LeadInput>): Promise<Lead> {
  const res = await fetch(`/api/leads/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseJson<{ ok: boolean; lead: Lead }>(res)
  return data.lead
}

export async function deleteLead(id: string): Promise<void> {
  await apiDelete(`/api/leads/${id}`)
}

/** Приоритет лида (§3.6): ответивший/горячий — выше. Зеркало server/leads.js#leadPriority. */
export function leadPriority(status: string): number {
  return ({ hot: 4, answered: 3, target: 2, cold: 1, closed: 0 } as Record<string, number>)[status] ?? 1
}

/** Сортировка лидов по приоритету (ответившему — приоритет). Не мутирует. */
export function sortLeadsByPriority(leads: Lead[]): Lead[] {
  return [...leads].sort((a, b) => leadPriority(b.status) - leadPriority(a.status) || (b.updatedAt || 0) - (a.updatedAt || 0))
}
