import { apiGet, apiPost, apiPut, apiDelete } from './client'

export type Perm = 'allow' | 'deny'

export interface RolePermissions {
  modules: Record<string, Perm>
  blocks: Record<string, Perm> // ключ = `${moduleKey}:${blockKey}`
  resources: {
    folders: Record<string, Perm>
    channels: Record<string, Perm>
    timers: Perm
    searchTemplates: Perm
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
export interface CatalogResourceItem { id: string; label: string }
export interface CatalogResource {
  type: 'folders' | 'channels' | 'timers' | 'searchTemplates'
  label: string
  perItem: boolean
  items?: CatalogResourceItem[]
}
export interface RbacCatalog {
  modules: CatalogModule[]
  blocks: CatalogBlock[]
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
  return { modules: {}, blocks: {}, resources: { folders: {}, channels: {}, timers: 'deny', searchTemplates: 'deny' } }
}
