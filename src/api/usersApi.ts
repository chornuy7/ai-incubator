import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Role } from './rolesApi'

export interface User {
  id: string
  email: string
  name: string
  roleId: string
  active: boolean
  createdAt: number
  updatedAt: number
}

export async function fetchUsers(): Promise<User[]> {
  const data = await apiGet<{ users: User[] }>('/api/users')
  return data.users
}

export async function loginUser(email: string, password: string): Promise<{ user: User; role: Role | null }> {
  const data = await apiPost<{ user: User; role: Role | null }>('/api/users/login', { email, password })
  return { user: data.user, role: data.role }
}

export async function createUser(input: { email: string; name?: string; roleId?: string; password: string; active?: boolean }): Promise<User> {
  const data = await apiPost<{ user: User }>('/api/users', input)
  return data.user
}

export async function updateUser(id: string, patch: { name?: string; roleId?: string; active?: boolean; password?: string }): Promise<User> {
  const data = await apiPut<{ user: User }>(`/api/users/${id}`, patch)
  return data.user
}

export async function deleteUser(id: string): Promise<void> {
  await apiDelete(`/api/users/${id}`)
}

export async function logoutUser(userId: string): Promise<void> {
  try { await apiPost('/api/users/logout', { userId }) } catch { /* best-effort */ }
}

export interface WorkSummary { todayMs: number; weekMs: number; open: boolean; since: number | null }

export async function fetchWorktime(): Promise<Record<string, WorkSummary>> {
  const data = await apiGet<{ worktime: Record<string, WorkSummary> }>('/api/users/worktime')
  return data.worktime
}
