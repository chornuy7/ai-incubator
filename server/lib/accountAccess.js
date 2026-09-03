/**
 * Кто какие аккаунты видит — вычисляется ОДИН раз на запрос.
 *
 * ЗАЧЕМ. `canSeeAccount` отвечает про один аккаунт, и это правильно для точечной
 * проверки. Но её звали в цикле: `mineOnly` перебирала карту «аккаунт → данные» и на
 * каждом ключе спрашивала заново. Внутри каждого такого вопроса — `getUser`,
 * `resolveSubscriptionOwner`, `getAccountMeta` (то есть чтение всей таблицы меты),
 * `rolesForUser` и `listGroups`. На парке из шестидесяти трёх аккаунтов это триста
 * пятнадцать обращений там, где ответ у всех один и тот же: права спрашивающего за время
 * одного HTTP-запроса не меняются.
 *
 * Здесь права считаются один раз и превращаются в область видимости, а дальше проверка
 * членства — обычная работа с множеством, без единого обращения к хранилищу.
 *
 * ВИДЫ ОБЛАСТИ.
 *
 *   all    — админ или запрос без сессии (дев/демо). Ограничений нет.
 *   none   — неизвестный, отключённый или сотрудник без единой выдачи. Не видно ничего.
 *   owner  — владелец пространства: все аккаунты, у которых `owner_id` — это он.
 *   scoped — сотрудник: аккаунты своего владельца И перечисленные явно (ролью, группой
 *            или личной выдачей), минус точечные запреты.
 *
 * FAIL-CLOSED СОХРАНЁН. Не смогли прочитать пользователя — `none`, как и было: отказ, а
 * не «пропустим на всякий случай». Это то место, где ошибка в сторону мягкости означает
 * показ чужих телефонов.
 */
import { getUser } from '../users.js'
import { userRoleIds, hasAdminRole, rolesForUser, mergePermissions } from '../roles.js'
import { applyDirectGrants } from '../subAccess.js'
import { listGroups } from '../accountGroups.js'

/**
 * @typedef {{kind: 'all'|'none'}
 *   | {kind: 'owner', ownerId: string}
 *   | {kind: 'scoped', ownerId: string, ids: Set<string>}} AccountScope
 */

/**
 * Область видимости аккаунтов для запроса.
 * @param {import('express').Request} req
 * @returns {Promise<AccountScope>}
 */
export async function accountScope(req) {
  const userId = req.header('x-user-id')
  if (!userId) return { kind: 'all' } // нет сессии — дев/демо, как в moduleAccessGuard

  let user = null
  try {
    user = await getUser(userId)
  } catch {
    return { kind: 'none' } // fail-closed: не смогли проверить — не отдаём
  }
  if (!user || !user.active) return { kind: 'none' }
  if (hasAdminRole(userRoleIds(user))) return { kind: 'all' }

  // Пространство. Сотрудник работает в пространстве своего владельца (§4.1).
  let ownerId = String(userId)
  try {
    const { resolveSubscriptionOwner } = await import('../users.js')
    ownerId = String((await resolveSubscriptionOwner(userId)) || userId)
  } catch { /* нет резолвера — считаем пространством себя */ }

  /*
   * Владельца роль не ограничивает: роль — это способ ВЫДАТЬ часть своего сотруднику,
   * а не урезать себя. Иначе клиент, зарегистрировавшийся сам и не заводивший ролей,
   * не попал бы к собственным аккаунтам — на них ведь тоже стоит этот гейт.
   */
  if (String(userId) === ownerId) return { kind: 'owner', ownerId }

  const roles = await rolesForUser(user)
  const естьВыдачи = (user.accountIds?.length || user.accountGroupIds?.length)
  if (!roles.length && !естьВыдачи) return { kind: 'none' }

  let perms = mergePermissions(roles)
  perms = applyDirectGrants(perms, user)
  const groups = await listGroups().catch(() => [])

  /*
   * Разворачиваем права в ПЕРЕЧЕНЬ идентификаторов.
   *
   * Это возможно потому, что подстановочного «все аккаунты» для сотрудника не бывает:
   * каждый доступ выдан либо точечно, либо группой, и то и другое — конечные списки.
   * Точечный запрет сильнее любого разрешения (§8.1) — вычитаем его последним.
   */
  const ids = new Set()
  for (const [id, v] of Object.entries(perms.resources?.accounts || {})) if (v === 'allow') ids.add(String(id))
  const разрешённыеГруппы = perms.resources?.accountGroups || {}
  for (const g of groups) {
    if (разрешённыеГруппы[g?.id] !== 'allow') continue
    for (const id of g.accountIds || []) ids.add(String(id))
  }
  for (const [id, v] of Object.entries(perms.resources?.accounts || {})) if (v === 'deny') ids.delete(String(id))

  if (!ids.size) return { kind: 'none' }
  return { kind: 'scoped', ownerId, ids }
}

/**
 * Виден ли аккаунт в этой области.
 *
 * `ownerId` аккаунта передаётся вызывающим — тем, у кого он уже есть под рукой (строка
 * списка, карточка). Не знаем владельца и область владельческая — считаем, что не виден:
 * аккаунты без владельца заведены до владельческой модели, они наши, и доступны только
 * админу. Ровно так вела себя `canSeeAccount`.
 *
 * @param {AccountScope} scope @param {string} accountId @param {string|null} [accountOwnerId]
 */
export function scopeAllows(scope, accountId, accountOwnerId) {
  if (!scope || scope.kind === 'none') return false
  if (scope.kind === 'all') return true
  const свой = accountOwnerId != null && String(accountOwnerId) === scope.ownerId
  if (scope.kind === 'owner') return свой
  return свой && scope.ids.has(String(accountId))
}

/**
 * Оставить в карте «аккаунт → данные» только видимые.
 *
 * Владельцев аккаунтов берём ОДНИМ запросом на всю карту, а не по одному: именно этот
 * перебор и был узким местом сводок `/busy` и `/daily-all`.
 *
 * @param {AccountScope} scope @param {Record<string, any>} map
 * @returns {Promise<Record<string, any>>}
 */
export async function filterAccountMap(scope, map) {
  const исходная = map || {}
  if (!scope || scope.kind === 'none') return {}
  if (scope.kind === 'all') return исходная
  const ids = Object.keys(исходная)
  if (!ids.length) return {}
  const владельцы = await accountOwners(ids)
  const out = {}
  for (const id of ids) if (scopeAllows(scope, id, владельцы.get(id))) out[id] = исходная[id]
  return out
}

/**
 * Отсеять из списка идентификаторов чужие — для массовых операций по выбору оператора.
 * @param {AccountScope} scope @param {string[]} ids
 * @returns {Promise<string[]>}
 */
export async function filterAccountIds(scope, ids = []) {
  if (!scope || scope.kind === 'none') return []
  if (scope.kind === 'all') return [...ids]
  if (!ids.length) return []
  const владельцы = await accountOwners(ids)
  return ids.filter((id) => scopeAllows(scope, id, владельцы.get(id)))
}

/**
 * Владельцы перечисленных аккаунтов — одним запросом.
 *
 * Читаются ДВЕ колонки, а не вся мета: узнать, чей аккаунт, можно по `user_id`, и тянуть
 * ради этого сорок колонок вместе с каталогом прокси незачем.
 *
 * @param {string[]} ids @returns {Promise<Map<string, string|null>>}
 */
export async function accountOwners(ids = []) {
  const нужные = [...new Set(ids.map(String).filter(Boolean))]
  const out = new Map()
  if (!нужные.length) return out
  const { getSupabase, supabaseEnabled } = await import('./supabase.js')
  const db = supabaseEnabled() ? getSupabase() : null
  if (!db) {
    // Файловый режим (тесты, локальный запуск): меты мало, читаем как есть.
    const { loadAllMeta } = await import('../accountsMeta.js')
    const all = await loadAllMeta().catch(() => ({}))
    for (const id of нужные) out.set(id, all[id]?.ownerId ?? null)
    return out
  }
  for (let i = 0; i < нужные.length; i += 200) {
    const кусок = нужные.slice(i, i + 200)
    const { data, error } = await db.from('accounts_meta').select('id, user_id').in('id', кусок)
    /*
     * Ошибку не глотаем. Молчаливый пустой ответ здесь означал бы «владельцев нет», то
     * есть «ни один аккаунт не твой» — сводка опустела бы без единого следа в логе.
     */
    if (error) throw new Error(`[accounts_meta] владельцы аккаунтов не прочитаны: ${error.message}`)
    for (const r of data || []) out.set(String(r.id), r.user_id ?? null)
  }
  return out
}
