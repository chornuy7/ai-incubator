/**
 * §4.1 (MR-28): доступ субпользователя к модулям ограничен теми, что оплачены владельцем.
 *
 * Подписка принадлежит рабочему пространству (`balance.js`): суб по умолчанию работает
 * внутри купленного владельцем набора (workspace), а если владелец оплатил модуль ОТДЕЛЬНО
 * субу — у суба появляется персональная запись, которая перекрывает workspace. Поэтому
 * «оплаченный субу набор» = `getBalance(sub).modules` (персональный ИЛИ workspace-fallback).
 *
 * Здесь — чистая обрезка: из выданных ролью модулей оставляем только оплаченные. Роль
 * может открывать больше, чем оплачено, — платёж главнее прав (иначе суб «видел» бы модуль,
 * которого у владельца нет). `'all'`/`null` — набор не ограничен, не режем.
 */
const ALLOW = 'allow'

/**
 * @param {import('./roles.js').RolePermissions|null} permissions эффективные права (union ролей)
 * @param {string[]|'all'|null|undefined} paidModules оплаченный субу набор
 * @returns права с модулями, обрезанными до оплаченных
 */
export function capModules(permissions, paidModules) {
  if (!permissions) return permissions
  if (paidModules === 'all' || paidModules == null) return permissions
  const paid = Array.isArray(paidModules) ? new Set(paidModules.map(String)) : new Set()
  const modules = {}
  for (const [k, v] of Object.entries(permissions.modules || {})) {
    // Явный deny сохраняем как есть; allow — только если модуль оплачен.
    if (v !== ALLOW) modules[k] = v
    else if (paid.has(k)) modules[k] = v
  }
  return { ...permissions, modules }
}

/**
 * §5.4 (MR-37): влить прямые выдачи аккаунтов/групп (с профиля суба) в эффективные права —
 * как `resources.accounts[id]='allow'` / `resources.accountGroups[id]='allow'`. За счёт этого
 * существующий резолвер доступа (isAccountAllowedViaGroups / filterAccountsByAccess) работает
 * без изменений — добавляем только данные. Точечный deny из ролей не перетираем.
 * @param {import('./roles.js').RolePermissions|null} permissions
 * @param {{accountIds?: string[], accountGroupIds?: string[]}} user
 */
export function applyDirectGrants(permissions, user) {
  if (!permissions) return permissions
  const accountIds = Array.isArray(user?.accountIds) ? user.accountIds : []
  const groupIds = Array.isArray(user?.accountGroupIds) ? user.accountGroupIds : []
  if (!accountIds.length && !groupIds.length) return permissions
  const resources = permissions.resources || {}
  const accounts = { ...(resources.accounts || {}) }
  const accountGroups = { ...(resources.accountGroups || {}) }
  for (const id of accountIds) if (accounts[id] !== 'deny') accounts[id] = ALLOW
  for (const id of groupIds) if (accountGroups[id] !== 'deny') accountGroups[id] = ALLOW
  return { ...permissions, resources: { ...resources, accounts, accountGroups } }
}
