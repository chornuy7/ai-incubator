import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Role } from './rolesApi'

export interface User {
  id: string
  email: string
  name: string
  roleId: string // «первичная» роль (админская если есть, иначе первая) — для отображения/детекта
  roleIds: string[] // мульти-роль: все роли пользователя (права суммируются)
  active: boolean
  parentId?: string | null // §10.4: под каким админом вложен суб-юзер (null — верхнеуровневый)
  accountIds?: string[] // §5.4 (MR-37): выданные субу одиночные аккаунты из пула владельца
  accountGroupIds?: string[] // §5.4 (MR-37): выданные субу группы аккаунтов
  balanceMode?: 'shared' | 'individual' // §4.2 (MR-30): общий с владельцем или индивидуальный лимит
  tokenLimit?: number | null // §4.2 (MR-30): лимит токенов для индивидуального режима
  createdAt: number
  updatedAt: number
}

export async function fetchUsers(): Promise<User[]> {
  const data = await apiGet<{ users: User[] }>('/api/users')
  return data.users
}

/** Токен сессии храним отдельным ключом — его шлёт `authHeaders` в `Authorization`. */
const TOKEN_KEY = 'ai-incubator:token'
function saveToken(token?: string) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY) } catch { /* quota */ }
}
export function clearToken() { saveToken(undefined) }

export async function loginUser(email: string, password: string): Promise<{ user: User; role: Role | null; isOwner: boolean }> {
  const data = await apiPost<{ user: User; role: Role | null; token?: string; isOwner?: boolean }>('/api/users/login', { email, password })
  saveToken(data.token)
  return { user: data.user, role: data.role, isOwner: !!data.isOwner }
}

/**
 * Самостоятельная регистрация с лендинга. Заводит юзера БЕЗ доступа к модулям —
 * админ выдаёт его вручную (фокус-группа). Сразу логинит (возвращает токен).
 */
export async function registerUser(email: string, password: string, name?: string, captchaToken?: string): Promise<{ user: User; role: Role | null; isOwner: boolean }> {
  const data = await apiPost<{ user: User; role: Role | null; token?: string; isOwner?: boolean }>('/api/users/register', { email, password, name, captchaToken })
  saveToken(data.token)
  return { user: data.user, role: data.role, isOwner: !!data.isOwner }
}

/** §10.2: включена ли капча на регистрации + её site-key (для виджета Turnstile). */
export async function fetchAuthConfig(): Promise<{ captcha: { enabled: boolean; siteKey: string } }> {
  return apiGet<{ captcha: { enabled: boolean; siteKey: string } }>('/api/users/auth-config')
}

/**
 * Кто я сейчас, с актуальными правами. Нужен, чтобы выданный/отозванный доступ
 * применялся без перезахода: права снимались снимком при входе.
 */
export async function fetchMe(): Promise<{ user: User; role: Role | null; isOwner: boolean }> {
  const r = await apiGet<{ user: User; role: Role | null; isOwner?: boolean }>('/api/users/me')
  return { user: r.user, role: r.role, isOwner: !!r.isOwner }
}

export async function createUser(input: { email: string; name?: string; roleId?: string; roleIds?: string[]; password: string; active?: boolean; parentId?: string | null; balanceMode?: 'shared' | 'individual'; tokenLimit?: number | null }): Promise<User> {
  const data = await apiPost<{ user: User }>('/api/users', input)
  return data.user
}

export async function updateUser(id: string, patch: { name?: string; roleId?: string; roleIds?: string[]; active?: boolean; password?: string; parentId?: string | null; accountIds?: string[]; accountGroupIds?: string[]; balanceMode?: 'shared' | 'individual'; tokenLimit?: number | null }): Promise<User> {
  const data = await apiPut<{ user: User }>(`/api/users/${id}`, patch)
  return data.user
}

export async function deleteUser(id: string): Promise<void> {
  await apiDelete(`/api/users/${id}`)
}

export async function logoutUser(userId: string): Promise<void> {
  clearToken() // токен недействителен для нас — убираем локально в любом случае
  try { await apiPost('/api/users/logout', { userId }) } catch { /* best-effort */ }
}

export interface WorkSummary { todayMs: number; weekMs: number; open: boolean; since: number | null }

export async function fetchWorktime(): Promise<Record<string, WorkSummary>> {
  const data = await apiGet<{ worktime: Record<string, WorkSummary> }>('/api/users/worktime')
  return data.worktime
}
