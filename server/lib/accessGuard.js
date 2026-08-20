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

      // Две оси, обе обязательны: РОЛЬ (что разрешил владелец) и ПОДПИСКА (что оплачено).
      // До 18.08 сервер смотрел только роль — и владелец без роли (обычная регистрация)
      // получал 403 на СВОИ оплаченные модули, хотя меню их показывало.
      const roles = await rolesForUser(user)
      const roleFree = roles.length === 0 && !user.parentId // владелец ролью не ограничен
      if (!roleFree && !roles.some((role) => can(role, 'module', key))) {
        const names = roles.map((r) => r.name).join(', ') || '—'
        return res.status(403).json({ ok: false, error: `Нет доступа к модулю (роли «${names}»)` })
      }

      // Подписка: `'all'` — без ограничений, список — строго по нему. Пустой набор с
      // 18.08 означает «не куплено ничего», и раньше он гейт не проходил, а обходил:
      // свежая регистрация запускала любой модуль. Витрина по-прежнему показывает
      // модули как промо — смотреть можно, работать нельзя.
      const { getBalance } = await import('../balance.js')
      const { modules } = await getBalance(userId)
      if (Array.isArray(modules) && !modules.includes(key)) {
        return res.status(403).json({
          ok: false,
          error: modules.length ? 'Модуль не входит в вашу подписку' : 'Модуль не оплачен — оформите подписку',
        })
      }
      return next()
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
 * Владелец-скоуп запроса: «чьи записи мне видно».
 *
 * Аудит 20.08 (инспектор): целый класс роутов объявлен как `async (_req, res)` — то есть
 * НЕ смотрит, кто спрашивает, и отдаёт данные всего пространства. Цели, кампании, группы
 * аккаунтов уже пишут владельца (lib/ownerColumn.js), но на ЧТЕНИИ фильтра не было: любой
 * из зарегистрировавшихся клиентов видел чужие цели/кампании прямым запросом. Требование
 * созвона — клиент видит только своё.
 *
 * Правило (то же, что у аккаунтов): считаем по ВЛАДЕЛЬЦУ ПРОСТРАНСТВА — суб видит то же,
 * что владелец (§4.1), админ и дев-режим (без сессии) видят всё.
 *
 * @returns {Promise<{ all:boolean, ownerId:string, blocked:boolean }>}
 */
export async function ownerScopeForRequest(req) {
  const ctx = await requesterContext(req)
  if (ctx.blocked) return { all: false, ownerId: '', blocked: true }
  if (ctx.noSession || ctx.isAdmin) return { all: true, ownerId: ctx.id, blocked: false }
  let ownerId = ctx.id
  try {
    const { resolveSubscriptionOwner } = await import('../users.js')
    ownerId = (await resolveSubscriptionOwner(ctx.id)) || ctx.id
  } catch { /* нет резолвера — остаёмся на себе */ }
  return { all: false, ownerId, blocked: false }
}

/**
 * Отфильтровать записи по владельцу для автора запроса.
 *
 * Записи БЕЗ владельца (легаси, заведены до владельческой модели) видит только админ —
 * отдавать их «всем» значило бы сохранить ту самую дыру, а привязать их к случайному
 * клиенту нельзя: мы не знаем, чьи они.
 *
 * @param {import('express').Request} req
 * @param {Array<object>} rows
 * @param {(row:object)=>string} ownerOf как достать владельца из записи
 */
export async function ownedForRequest(req, rows = [], ownerOf = (r) => r?.userId || r?.user_id || '') {
  const scope = await ownerScopeForRequest(req)
  if (scope.blocked) return []
  if (scope.all) return rows
  return rows.filter((r) => String(ownerOf(r) || '') === String(scope.ownerId))
}

/**
 * Каналы, доступные автору запроса.
 *
 * Модель (уточнил заказчик 20.08): база каналов — НАША, общая. У клиента своей базы нет:
 * он парсит, найденное ложится в общую базу (дедуп по каналу — один ряд на канал, статистика
 * обновляется один раз), и оттуда мы отдаём ему результат. Поэтому владельца у РЯДА нет и
 * дублей на клиента мы не плодим — иначе планировщик статистики дёргал бы Telegram по одному
 * каналу N раз (лишний риск для аккаунтов).
 *
 * Видимость считаем по ПРОГОНАМ: воркер парсера пишет источник `parse:<taskId>`
 * (workers.js), а у задачи есть владелец. Клиент видит каналы, которые нашли ЕГО прогоны.
 * Если он парсит уже известный канал — upsert добавит его `parse:<taskId>` в sources, и канал
 * станет виден ему с ОБНОВЛЁННЫМИ данными (ровно то поведение, что описал заказчик).
 *
 * Кэш карты «задача → владелец» на 30с: собирается из сторов парсер-модулей, а /api/channels
 * дёргают часто.
 */
let _taskOwnerCache = null // { map: Map<taskId, userId>, ts }
const TASK_OWNER_TTL = 30_000
async function parseTaskOwners() {
  if (_taskOwnerCache && Date.now() - _taskOwnerCache.ts < TASK_OWNER_TTL) return _taskOwnerCache.map
  const map = new Map()
  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      if (!/^parsing/.test(key)) continue // источники пишет только парсер
      const store = getModuleStore(key)
      if (!store) continue
      try {
        for (const t of await store.listTasks()) if (t?.id) map.set(t.id, t.userId || '')
      } catch { /* модуль недоступен — пропускаем */ }
    }
  } catch { /* нет реестра — отдадим пустую карту (клиент увидит 0, админ — всё) */ }
  _taskOwnerCache = { map, ts: Date.now() }
  return map
}

export async function channelsForRequest(req, channels = []) {
  const scope = await ownerScopeForRequest(req)
  if (scope.blocked) return []
  if (scope.all) return channels // админ и дев-режим видят всю базу
  const owners = await parseTaskOwners()
  const mine = new Set([scope.ownerId, req.header('x-user-id') || ''].filter(Boolean))
  return channels.filter((c) => (c?.sources || []).some((s) => {
    const taskId = String(s || '').replace(/^parse:/, '')
    return mine.has(owners.get(taskId) || '')
  }))
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
