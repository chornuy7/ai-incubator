import type { RolePermissions, Perm } from '@/api/rolesApi'

export type PermKind = 'module' | 'block' | 'section' | 'account' | 'accountGroup' | 'folder' | 'channel' | 'timers' | 'searchTemplates'

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
    case 'section': return val(permissions.sections?.[key ?? ''])
    case 'account': return val(permissions.resources.accounts?.[key ?? ''])
    case 'accountGroup': return val(permissions.resources.accountGroups?.[key ?? ''])
    case 'folder': return val(permissions.resources.folders[key ?? ''])
    case 'channel': return val(permissions.resources.channels[key ?? ''])
    case 'timers': return val(permissions.resources.timers)
    case 'searchTemplates': return val(permissions.resources.searchTemplates)
    default: return false
  }
}

/**
 * Отфильтровать аккаунты по доступу роли (R4): не-админ видит только выданные ему аккаунты.
 * Админ → полный список; по умолчанию (нет выдач) не-админ видит пусто.
 * Случай «нет сессии» (демо) сюда НЕ доезжает — вызывающие показывают полный список
 * до фильтра (см. AccountsPage / AccountPicker), иначе демо было бы пустым.
 */
export function filterAccountsByAccess<T extends { id: string }>(
  list: T[], permissions: RolePermissions | null, isAdmin: boolean,
  groups: { id: string; accountIds: string[] }[] = [],
): T[] {
  if (isAdmin) return list
  return list.filter((a) => isAccountAllowed(permissions, a.id, groups))
}

/**
 * §12: аккаунт доступен роли напрямую ИЛИ через разрешённую группу.
 * Точечный deny сильнее группового allow. Зеркало server/accountGroups.js.
 */
export function isAccountAllowed(
  permissions: RolePermissions | null, accountId: string,
  groups: { id: string; accountIds: string[] }[] = [],
): boolean {
  if (!permissions) return false
  const direct = permissions.resources.accounts?.[accountId]
  if (direct === 'deny') return false // точечный запрет важнее
  if (direct === 'allow') return true
  return groups.some((g) => can(permissions, false, 'accountGroup', g.id) && g.accountIds.includes(accountId))
}

/** Извлечь ключ модуля из пути роутинга (/panel/modules/<key>). */
export function moduleKeyFromPath(path: string): string | null {
  const m = path.match(/^\/panel\/modules\/([^/]+)$/)
  return m ? m[1] : null
}

/** Страницы только для админа (управление ролями/пользователями). §8.1 */
export const ADMIN_ONLY_PATHS = new Set(['/panel/roles', '/panel/users'])
/** Минимум, доступный всем всегда (свой профиль + поддержка) — не гейтится ролью. */
export const ALWAYS_ON_PATHS = new Set(['/panel/user/profile', '/panel/support'])
/** Модули вне /panel/modules/* — их доступ проверяется как 'module' по этому ключу. */
const SPECIAL_MODULE_PATHS: Record<string, string> = {
  '/panel/mailing': 'mailing',
  '/panel/autoposting': 'autoposting',
}

/**
 * Разрешён ли доступ к странице панели для роли (§8.1). Зеркалит сайдбар и guard прямого URL.
 * Порядок: админ-страницы (только админ) → always-on → модули (по ключу) → остальное как 'section'.
 * @param isAdmin — bypass; permissions null трактуется как deny (кроме always-on).
 */
export function canAccessPath(permissions: RolePermissions | null, isAdmin: boolean, path: string): boolean {
  if (isAdmin) return true
  if (ADMIN_ONLY_PATHS.has(path)) return false
  if (ALWAYS_ON_PATHS.has(path)) return true
  const mk = moduleKeyFromPath(path) ?? SPECIAL_MODULE_PATHS[path]
  if (mk) return can(permissions, false, 'module', mk)
  return can(permissions, false, 'section', path)
}
