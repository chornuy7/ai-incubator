import type { RolePermissions, Perm } from '@/api/rolesApi'

export type PermKind = 'module' | 'block' | 'folder' | 'channel' | 'timers' | 'searchTemplates'

/**
 * Клиентская проверка доступа (зеркало server/roles.js#can). Админ (isAdmin) — всегда true;
 * отсутствующий ключ — deny (безопасный дефолт). §8.1.
 */
export function can(permissions: RolePermissions | null, isAdmin: boolean, kind: PermKind, key?: string): boolean {
  if (isAdmin) return true
  if (!permissions) return false
  const val = (v?: Perm) => v === 'allow'
  switch (kind) {
    case 'module': return val(permissions.modules[key ?? ''])
    case 'block': return val(permissions.blocks[key ?? ''])
    case 'folder': return val(permissions.resources.folders[key ?? ''])
    case 'channel': return val(permissions.resources.channels[key ?? ''])
    case 'timers': return val(permissions.resources.timers)
    case 'searchTemplates': return val(permissions.resources.searchTemplates)
    default: return false
  }
}

/** Извлечь ключ модуля из пути роутинга (/panel/modules/<key>). */
export function moduleKeyFromPath(path: string): string | null {
  const m = path.match(/^\/panel\/modules\/([^/]+)$/)
  return m ? m[1] : null
}
