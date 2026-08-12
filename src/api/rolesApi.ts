import { apiGet, apiPost, apiPut, apiDelete } from './client'

export type Perm = 'allow' | 'deny'

export interface RolePermissions {
  /** Роль «без оплаты» (тест/модератор): доступ к модулям даёт роль в обход подписки. */
  freeAccess?: boolean
  modules: Record<string, Perm>
  blocks: Record<string, Perm> // ключ = `${moduleKey}:${blockKey}`
  sections: Record<string, Perm> // ключ = путь раздела (напр. '/panel/proxies')
  resources: {
    accounts: Record<string, Perm> // ключ = accountId (кто виден роли в менеджере/пикере)
    /** §12: groupId → allow/deny. Доступ выдаётся сразу на группу аккаунтов. */
    accountGroups?: Record<string, Perm>
    folders: Record<string, Perm>
    channels: Record<string, Perm>
    /** Какие каналы внутри папки выданы роли: folderId → список ссылок. Пусто = все каналы папки. */
    folderChannels: Record<string, string[]>
    timers: Perm
    searchTemplates: Perm
    /** Видеть и вести в Дашборде ЧУЖИЕ задачи. По умолчанию человек видит только свои. */
    allTasks?: Perm
    /** Поддержка: видеть все тикеты пользователей и отвечать в них «как поддержка». */
    support?: Perm
  }
}

export interface Role {
  id: string
  name: string
  builtin?: boolean
  isTemplate?: boolean
  permissions: RolePermissions
  createdAt: number
  updatedAt: number
}

export interface CatalogModule { key: string; label: string }
export interface CatalogBlock { key: string; label: string }
export interface CatalogSection { key: string; label: string }
export interface CatalogResourceItem { id: string; label: string; channels?: string[] }
export interface CatalogResource {
  type: 'accounts' | 'accountGroups' | 'folders' | 'channels' | 'timers' | 'searchTemplates' | 'allTasks' | 'support'
  label: string
  perItem: boolean
  items?: CatalogResourceItem[]
}
export interface RbacCatalog {
  modules: CatalogModule[]
  blocks: CatalogBlock[]
  sections: CatalogSection[]
  resources: CatalogResource[]
}

export async function fetchRoles(): Promise<Role[]> {
  const data = await apiGet<{ roles: Role[] }>('/api/roles')
  return data.roles
}

export async function fetchRbacCatalog(): Promise<RbacCatalog> {
  const data = await apiGet<{ catalog: RbacCatalog }>('/api/roles/catalog')
  return data.catalog
}

export async function createRole(input: { name: string; isTemplate?: boolean; permissions?: Partial<RolePermissions> }): Promise<Role> {
  const data = await apiPost<{ role: Role }>('/api/roles', input)
  return data.role
}

export async function updateRole(id: string, patch: { name?: string; isTemplate?: boolean; permissions?: RolePermissions }): Promise<Role> {
  const data = await apiPut<{ role: Role }>(`/api/roles/${id}`, patch)
  return data.role
}

export async function deleteRole(id: string): Promise<void> {
  await apiDelete(`/api/roles/${id}`)
}

/** Пустые права (всё deny) — для новой роли. */
export function emptyPermissions(): RolePermissions {
  return { freeAccess: false, modules: {}, blocks: {}, sections: {}, resources: { accounts: {}, accountGroups: {}, folders: {}, channels: {}, folderChannels: {}, timers: 'deny', searchTemplates: 'deny', allTasks: 'deny' } }
}
