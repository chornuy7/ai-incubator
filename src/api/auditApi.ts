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

/**
 * `scope: 'all'` — весь журнал пространства (только администратору). По умолчанию сервер
 * отдаёт свои записи и записи своих сотрудников даже админу: в своём журнале нужны свои
 * задачи, а не входы чужих сотрудников вперемешку (правка 27.08).
 */
export async function fetchAudit(filter: { action?: string; initiator?: string; limit?: number; scope?: 'all' } = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams(
    Object.entries(filter).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString()
  const data = await apiGet<{ ok: boolean; entries: AuditEntry[] }>(`/api/audit${qs ? `?${qs}` : ''}`)
  return data.entries
}
