/**
 * Серверный enforcement RBAC (§8.1): гейт доступа к модулю по роли пользователя.
 * Пользователь идентифицируется заголовком `X-User-Id` (клиент шлёт id из сессии).
 *
 * Дев-модель: если заголовка нет — пропускаем (демо/админ без сессии). Если есть и юзер
 * не админ — проверяем `can(role,'module',key)`; при отказе — 403. Продакшн-шаг: заменить
 * заголовок на подписанный токен сессии (см. docs/CONTRACT-rbac.md §7).
 */
import { getUser } from '../users.js'
import { can, userRoleIds, hasAdminRole, rolesForUser } from '../roles.js'

/**
 * Guard для монтирования на префикс модуля. `keyFrom(req)` извлекает ключ модуля.
 * @param {(req: import('express').Request) => string|null} keyFrom
 */
export function moduleAccessGuard(keyFrom) {
  return async function guard(req, res, next) {
    try {
      const userId = req.header('x-user-id')
      if (!userId) return next() // нет сессии — дев/демо
      const key = keyFrom(req)
      if (!key) return next() // не модульный путь (список задач и т.п.)
      const user = await getUser(userId)
      if (!user || !user.active) return next()
      if (hasAdminRole(userRoleIds(user))) return next() // админ среди ролей — bypass
      const roles = await rolesForUser(user)
      if (roles.some((role) => can(role, 'module', key))) return next() // union: доступ даёт любая роль
      const names = roles.map((r) => r.name).join(', ') || '—'
      return res.status(403).json({ ok: false, error: `Нет доступа к модулю (роли «${names}»)` })
    } catch {
      return next() // guard не должен ронять запрос
    }
  }
}

/** Ключ модуля из /api/modules/<key>/... (первый сегмент; 'tasks' — не модуль). */
export function moduleKeyFromModulesPath(req) {
  const seg = String(req.path || '').split('/').filter(Boolean)[0]
  if (!seg || seg === 'tasks') return null
  return seg
}
