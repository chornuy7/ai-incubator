import { apiGet } from './client'

export interface AuditEntry {
  id: string
  ts: string
  action: string
  module: string
  initiator: string
  code: string
  reason: string
  scope: Record<string, unknown>
  account?: string
  meta?: Record<string, unknown>
}

export async function fetchAudit(filter: { action?: string; initiator?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams(
    Object.entries(filter).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString()
  const data = await apiGet<{ ok: boolean; entries: AuditEntry[] }>(`/api/audit${qs ? `?${qs}` : ''}`)
  return data.entries
}
