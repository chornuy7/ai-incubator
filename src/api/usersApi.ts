import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Role, Perm, CatalogModule, CatalogBlock } from './rolesApi'
import { tokenKey } from '@/features/auth/zone'

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

/**
 * По умолчанию — только свои субпользователи (+ сам). `scope: 'all'` даёт список всей
 * платформы и работает лишь у админа: обычному владельцу сервер всё равно вернёт своих.
 */
export async function fetchUsers(scope?: 'mine' | 'all'): Promise<User[]> {
  const data = await apiGet<{ users: User[] }>(`/api/users${scope === 'all' ? '?scope=all' : ''}`)
  return data.users
}

// Токен сессии храним отдельным ключом — его шлёт `authHeaders` в `Authorization`.
// Ключ ЗАВИСИТ ОТ ЗОНЫ (панель/админка): вход на /admin кладёт админ-токен, вход в панель —
// панельный, чтобы зоны были независимы (созвон 19.08). tokenKey() выбирает по текущему URL.
function saveToken(token?: string) {
  try { if (token) localStorage.setItem(tokenKey(), token); else localStorage.removeItem(tokenKey()) } catch { /* quota */ }
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

/** Смена собственного пароля: сервер проверяет текущий пароль по БД. */
export async function changeMyPassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiPost('/api/users/me/password', { currentPassword, newPassword })
}

export async function logoutUser(userId: string): Promise<void> {
  clearToken() // токен недействителен для нас — убираем локально в любом случае
  try { await apiPost('/api/users/logout', { userId }) } catch { /* best-effort */ }
}

/**
 * Доступ СУБПОЛЬЗОВАТЕЛЯ к модулям и блокам (уточнение владельца 21.08).
 *
 * Живёт на пользователе, а не на отдельной странице ролей: владелец думает не «какие у меня
 * роли», а «что видит вот этот человек». Физически сервер всё равно держит персональную роль
 * суба — просто заводит и правит её сам по PUT, а владелец её не видит.
 *
 * `catalog.modules` УЖЕ отфильтрован подпиской владельца — фильтровать повторно нельзя:
 * иначе оплаченный модуль пропадёт из списка и это прочтётся как поломка.
 * Ключ блока — `${moduleKey}:${blockKey}`, как в ролях (см. RolePermissions.blocks).
 */
export interface UserAccess {
  modules: Record<string, Perm>
  blocks: Record<string, Perm>
  catalog: { modules: CatalogModule[]; blocks: CatalogBlock[] }
}

export async function fetchUserAccess(id: string): Promise<UserAccess> {
  const r = await apiGet<{ ok: boolean } & UserAccess>(`/api/users/${id}/access`)
  return { modules: r.modules || {}, blocks: r.blocks || {}, catalog: { modules: r.catalog?.modules || [], blocks: r.catalog?.blocks || [] } }
}

/**
 * Сохранить доступ суба. Сервер сам проверяет, что модуль оплачен подпиской владельца, —
 * клиентский список ему не указ (прямой запрос обошёл бы форму).
 */
export async function saveUserAccess(id: string, patch: { modules: Record<string, Perm>; blocks: Record<string, Perm> }): Promise<void> {
  await apiPut(`/api/users/${id}/access`, patch)
}

export interface WorkSummary { todayMs: number; weekMs: number; open: boolean; since: number | null }

export async function fetchWorktime(): Promise<Record<string, WorkSummary>> {
  const data = await apiGet<{ worktime: Record<string, WorkSummary> }>('/api/users/worktime')
  return data.worktime
}

/**
 * §5.3 (MR-36): открыть панель ГЛАЗАМИ клиента, чтобы проверить его доступы.
 * Возвращает обычную панельную сессию этого пользователя — интерфейс покажет ровно то,
 * что видит он сам. Каждый такой вход пишется в аудит на сервере.
 */
export async function impersonate(userId: string): Promise<{ user: User; role: Role | null; isOwner: boolean; token: string }> {
  const r = await apiPost<{ user: User; role: Role | null; isOwner: boolean; token: string }>('/api/users/impersonate', { userId })
  return { user: r.user, role: r.role ?? null, isOwner: !!r.isOwner, token: r.token }
}
