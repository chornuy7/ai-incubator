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
