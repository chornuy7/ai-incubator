/**
 * Серверный enforcement RBAC (§8.1): гейт доступа к модулю по роли пользователя.
 * Пользователь идентифицируется заголовком `X-User-Id` (клиент шлёт id из сессии).
 *
 * Дев-модель: если заголовка нет — пропускаем (демо/админ без сессии). Если есть —
 * отключённый или неизвестный пользователь получает 403, админ проходит, остальным
 * проверяем `can(role,'module',key)`; при отказе — 403. Продакшн-шаг: заменить
 * заголовок на подписанный токен сессии (см. docs/CONTRACT-rbac.md §7).
 */
import { getUser } from '../users.js'
import { can, userRoleIds, hasAdminRole, hasSupportCap, rolesForUser, allowedFolderTargets, mergePermissions } from '../roles.js'
import { applyDirectGrants } from '../subAccess.js'
import { isAccountAllowedViaGroups, listGroups } from '../accountGroups.js'

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
      // Неизвестный или отключённый — fail-closed, как в isAdminRequest и
      // tasksForRequest. Раньше здесь стоял next(), то есть отключённый сотрудник
      // проходил гейт модулей: увольнение не закрывало доступ.
      if (!user || !user.active) {
        return res.status(403).json({ ok: false, error: 'Пользователь отключён' })
      }
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

/**
 * §12: админ ли автор запроса (по тому же `X-User-Id`). Нужен там, где проверку нельзя
 * оставлять фронту — например остановка прогрева (недели работы, откатить нельзя).
 *
 * Нет заголовка — дев/демо, считаем админом (как и `moduleAccessGuard`, который без
 * сессии пропускает). Ошибка/неизвестный юзер — НЕ админ: тут дешевле отказать.
 * @returns {Promise<boolean>}
 */
export async function isAdminRequest(req) {
  try {
    const userId = req.header('x-user-id')
    if (!userId) return true // нет сессии — дев/демо
    const user = await getUser(userId)
    if (!user || !user.active) return false
    return hasAdminRole(userRoleIds(user))
  } catch {
    return false // fail-closed: защищаем дорогое действие
  }
}

/**
 * §4.1 (MR-29): контекст автора запроса для owner-scoping управления субами/ролями/группами.
 * До этого CRUD users/roles/account-groups не проверял права на сервере вообще (гейт был
 * только во фронте) — владелец мог править чужое прямым запросом. Здесь — единая точка:
 *  - noSession (нет заголовка) → дев/демо, полный доступ (как isAdminRequest);
 *  - blocked → отключённый/неизвестный, отказать;
 *  - isAdmin → sudo-обход;
 *  - иначе владелец: управляет только тем, что принадлежит ему (parentId/userId === id).
 * @returns {Promise<{id:string, user:object|null, isAdmin:boolean, noSession:boolean, blocked:boolean}>}
 */
export async function requesterContext(req) {
  const id = req.header('x-user-id') || ''
  if (!id) return { id: '', user: null, isAdmin: true, noSession: true, isSupport: true, blocked: false }
  try {
    const user = await getUser(id)
    if (!user || !user.active) return { id, user: null, isAdmin: false, noSession: false, isSupport: false, blocked: true }
    const isAdmin = hasAdminRole(userRoleIds(user))
    // isSupport: админ, дев-режим (см. выше) или роль с правом «Поддержка» — видит все
    // тикеты и отвечает как поддержка.
    const isSupport = isAdmin || hasSupportCap(await rolesForUser(user))
    return { id, user, isAdmin, noSession: false, isSupport, blocked: false }
  } catch {
    return { id, user: null, isAdmin: false, noSession: false, isSupport: false, blocked: true }
  }
}

/**
 * §8.1: папки целей, доступные автору запроса, с урезанными списками каналов.
 *
 * Раньше фильтрация жила ТОЛЬКО во фронте (`visibleFolders`/`allowedTargets` в
 * FolderPicker.tsx), а `GET /api/target-folders` отдавал все папки всем — то есть
 * это было сокрытие в интерфейсе, а не разграничение доступа: devtools или прямой
 * запрос возвращали базы каналов всех ролей. Прогон 21–22.07, тест 11.7.
 *
 * Семантика прав — union по ролям (как `moduleAccessGuard`): папка видна, если её
 * разрешает ХОТЬ ОДНА роль; список каналов папки — объединение разрешённых каналов
 * по всем ролям пользователя.
 *
 * @param {import('express').Request} req
 * @param {Array<{id:string,targets?:string[]}>} folders
 * @returns {Promise<Array<object>>}
 */
export async function foldersForRequest(req, folders = []) {
  const userId = req.header('x-user-id')
  if (!userId) return folders // нет сессии — дев/демо, как в moduleAccessGuard
  let user = null
  try {
    user = await getUser(userId)
  } catch {
    return [] // fail-closed: не смогли проверить — не отдаём чужие базы каналов
  }
  if (!user || !user.active) return []
  if (hasAdminRole(userRoleIds(user))) return folders
  const roles = await rolesForUser(user)
  if (!roles.length) return []
  const out = []
  for (const f of folders) {
    const targets = f.targets || []
    // union: собираем разрешённое по всем ролям, дубли схлопывает Set
    const allowed = [...new Set(roles.flatMap((role) => allowedFolderTargets(role, f.id, targets)))]
    if (!allowed.length && targets.length) continue // ни одна роль не дала доступа
    out.push({ ...f, targets: allowed })
  }
  return out
}

/**
 * §8.1: чьи задачи видит автор запроса.
 *
 * По умолчанию человек видит в Дашборде ТОЛЬКО свои запуски: чужая задача — это
 * чужие аккаунты, цели и переписка, и показывать их всем подряд нельзя. Дашборд
 * целиком открывают админ и роль с правом `allTasks` (тимлид, ответственный
 * за сетку) — как и просил заказчик: «всё видит админ или тот, кому он дал доступ».
 *
 * Задачи без владельца (созданные до того, как владельца стали запоминать) считаем
 * общими — только для тех, кто и так видит всё. Отдавать их всем значило бы оставить
 * дыру ровно того размера, что и была.
 *
 * @param {import('express').Request} req
 * @param {Array<{userId?:string}>} tasks
 * @returns {Promise<Array<object>>}
 */
/**
 * Доступен ли автору запроса конкретный аккаунт (§8.1, ресурс `accounts`).
 *
 * Нужен там, где отдаём данные ПО аккаунту, а не список: список фильтрует фронт
 * через `filterAccountsByAccess`, но точечный запрос по id так не прикрыть —
 * без этой проверки чужой профиль отдавал бы задачи, деньги и лиды.
 * @param {import('express').Request} req @param {string} accountId
 */
export async function canSeeAccount(req, accountId) {
  const userId = req.header('x-user-id')
  if (!userId) return true // нет сессии — дев/демо, как в moduleAccessGuard
  let user = null
  try {
    user = await getUser(userId)
  } catch {
    return false // fail-closed: не смогли проверить — не отдаём
  }
  if (!user || !user.active) return false
  if (hasAdminRole(userRoleIds(user))) return true
  const roles = await rolesForUser(user)
  const hasGrants = (user.accountIds?.length || user.accountGroupIds?.length)
  if (!roles.length && !hasGrants) return false
  // §5.4 (MR-37): точечная проверка учитывает и группы, и прямые выдачи субу — как
  // filterAccountsByAccess во фронте. Раньше здесь смотрели только прямые role.accounts,
  // и доступ, выданный ГРУППОЙ, на точечном запросе молча не работал.
  let perms = mergePermissions(roles)
  perms = applyDirectGrants(perms, user)
  const groups = await listGroups().catch(() => [])
  return isAccountAllowedViaGroups(perms.resources.accounts, perms.resources.accountGroups, groups, String(accountId))
}

export async function tasksForRequest(req, tasks = []) {
  const userId = req.header('x-user-id')
  if (!userId) return tasks // нет сессии — дев/демо, как в moduleAccessGuard
  let user = null
  try {
    user = await getUser(userId)
  } catch {
    return [] // fail-closed: не смогли проверить — не показываем чужую работу
  }
  if (!user || !user.active) return []
  if (hasAdminRole(userRoleIds(user))) return tasks
  const roles = await rolesForUser(user)
  if (roles.some((role) => can(role, 'allTasks'))) return tasks
  return tasks.filter((t) => t && t.userId === userId)
}

/**
 * Доступна ли автору запроса конкретная задача — для чтения и для управления
 * (пауза/стоп/перезапуск/правка). Без этой проверки скрытие в списке было бы
 * косметикой: id задачи виден в интерфейсе, и остановить чужую можно было бы
 * прямым запросом.
 * @returns {Promise<boolean>}
 */
export async function canTouchTask(req, task) {
  if (!task) return false
  const [visible] = await tasksForRequest(req, [task])
  return Boolean(visible)
}

/** Ключ модуля из /api/modules/<key>/... (первый сегмент; 'tasks' — не модуль). */
export function moduleKeyFromModulesPath(req) {
  const seg = String(req.path || '').split('/').filter(Boolean)[0]
  if (!seg || seg === 'tasks') return null
  return seg
}
