import { apiGet, apiPost, apiDelete } from './client'

/**
 * MR-149 (созвон 19.08): готовые сетапы (скидочные наборы модулей) — из БД, правятся
 * из админки. Сетап = скидка (доля) от суммы входящих модулей; `allModules` — «Всё
 * включено» (состав = все модули платформы).
 */
export interface AdminSetup {
  id: string
  name: string
  hint: string
  discount: number // доля 0..0.9
  modules: string[]
  allModules?: boolean
}

export async function fetchSetups(): Promise<AdminSetup[]> {
  const r = await apiGet<{ ok: boolean; setups: AdminSetup[] }>('/api/admin/setups')
  return r.setups || []
}

export async function saveSetup(input: Partial<AdminSetup>): Promise<AdminSetup> {
  const r = await apiPost<{ ok: boolean; setup: AdminSetup }>('/api/admin/setups', input)
  return r.setup
}

export async function deleteSetup(id: string): Promise<void> {
  await apiDelete(`/api/admin/setups/${encodeURIComponent(id)}`)
}
