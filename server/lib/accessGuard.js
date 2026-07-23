/**
 * Серверный enforcement RBAC (§8.1): гейт доступа к модулю по роли пользователя.
 * Пользователь идентифицируется заголовком `X-User-Id` (клиент шлёт id из сессии).
 *
 * Дев-модель: если заголовка нет — пропускаем (демо/админ без сессии). Если есть и юзер
 * не админ — проверяем `can(role,'module',key)`; при отказе — 403. Продакшн-шаг: заменить
 * заголовок на подписанный токен сессии (см. docs/CONTRACT-rbac.md §7).
 */
import { getUser } from '../users.js'
import { can, userRoleIds, hasAdminRole, rolesForUser, allowedFolderTargets } from '../roles.js'

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

/** Ключ модуля из /api/modules/<key>/... (первый сегмент; 'tasks' — не модуль). */
export function moduleKeyFromModulesPath(req) {
  const seg = String(req.path || '').split('/').filter(Boolean)[0]
  if (!seg || seg === 'tasks') return null
  return seg
}
