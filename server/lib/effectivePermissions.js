/**
 * Эффективные права пользователя — ОДНА реализация на весь сервер.
 *
 * Считать «что человеку можно» в двух местах нельзя: расхождение здесь означает, что
 * панель показывает одно, а API отвечает другое, и разбираться в этом придётся уже по
 * жалобе. Функция жила приватной внутри `usersRoutes.js` и обслуживала вход и `/me`;
 * теперь её же читает слой capabilities (`server/mcp/capabilities.js`), который
 * рассказывает «мозгам», что им разрешено.
 *
 * Логика не менялась при выносе — это ровно тот код, что обслуживал вход.
 */
import { rolesForUser, mergePermissions, unrestrictedPermissions, userRoleIds, hasAdminRole } from '../roles.js'
import { capModules, applyDirectGrants } from '../subAccess.js'
import { getBalance } from '../balance.js'

/**
 * Эффективные права пользователя (union ролей) + §4.1 (MR-28) обрезка модулей суба до
 * оплаченных владельцем.
 * freeAccess-роль (тест/модератор) — доступ в обход подписки, её не режем.
 *
 * @returns {Promise<object|null>} карта прав; `null` = «правами не ограничен» (админ)
 */
export async function effectivePermissions(user, roles, isAdmin) {
  // `null` = «правами не ограничен», и так это понимает сервер. Но клиентский `can()`
  // читает null как «прав нет» и закрывает всё — из-за этого владелец без роли (обычная
  // самостоятельная регистрация) видел пустое меню, хотя модули оплачены. Админу null
  // безопасен: у него отдельный обход (isAdmin), а вот роль-less ВЛАДЕЛЬЦУ выдаём явные
  // права. Суб без роли остаётся без прав — сотруднику доступ выдаёт владелец.
  const { listModuleKeys } = await import('../modules/registry.js')
  let permissions = isAdmin
    ? null
    : roles.length === 0
      ? (user.parentId ? mergePermissions([]) : unrestrictedPermissions(listModuleKeys()))
      : mergePermissions(roles)
  const freeAccess = roles.some((r) => r?.permissions?.freeAccess)
  if (permissions && user.parentId && !freeAccess) {
    const bal = await getBalance(user.id).catch(() => null)
    permissions = capModules(permissions, bal?.modules)
  }
  // §5.4 (MR-37): прямые выдачи аккаунтов/групп субу — в эффективные права.
  if (permissions) permissions = applyDirectGrants(permissions, user)
  return permissions
}

/**
 * Полный разбор личности: роли, признаки и эффективные права одним вызовом.
 *
 * Имя роли считается здесь же, а не у вызывающего: верхнеуровневый пользователь без
 * роли — это ВЛАДЕЛЕЦ своего пространства, а не «роль не задана» (правка 18.08).
 *
 * @param {object} user запись пользователя
 * @returns {Promise<{user: object, roles: object[], roleIds: string[], isAdmin: boolean,
 *   isSub: boolean, isOwner: boolean, roleName: string, permissions: object|null}>}
 */
export async function resolveUserAccess(user) {
  const roleIds = userRoleIds(user)
  const roles = await rolesForUser(user)
  const isAdmin = hasAdminRole(roleIds)
  const permissions = await effectivePermissions(user, roles, isAdmin)
  const isSub = !!user.parentId
  const roleName = roles.length
    ? roles.map((r) => r.name).join(' + ')
    : (isAdmin ? 'Администратор' : (isSub ? '' : 'Владелец'))
  return { user, roles, roleIds, isAdmin, isSub, isOwner: !isAdmin && !isSub, roleName, permissions }
}
