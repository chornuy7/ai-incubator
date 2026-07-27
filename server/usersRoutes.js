/** CRUD + аутентификация операторов (§8.1). Монтируется в /api/users. */
import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, authenticate, publicUser } from './users.js'
import { rolesForUser, mergePermissions, userRoleIds, hasAdminRole } from './roles.js'
import { appendAudit } from './lib/auditLog.js'
import { clockIn, clockOut, summariesFor } from './workLog.js'
import { signSession } from './lib/session.js'

/** Собрать ответ входа: публичный юзер + роль (для гейта UI) + подписанный токен. */
async function sessionPayload(user) {
  const ids = userRoleIds(user)
  const roles = await rolesForUser(user)
  const isAdmin = hasAdminRole(ids)
  const permissions = isAdmin || roles.length === 0 ? null : mergePermissions(roles)
  const role = { id: user.roleId || '', name: roles.map((r) => r.name).join(' + '), permissions }
  return { user, role, roles, token: signSession(user.id) }
}

export const usersRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

usersRouter.get('/', async (_req, res) => {
  try {
    const users = await listUsers()
    res.json({ ok: true, users: users.map(publicUser) })
  } catch (err) { fail(res, err, 500) }
})

/** Логин: публичный юзер + роль (гейт UI) + подписанный токен сессии. */
usersRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {}
    const user = await authenticate(email, password)
    if (!user) {
      await appendAudit({ action: 'user.login.fail', module: 'auth', initiator: 'system', reason: `Неудачный вход: ${String(email || '').slice(0, 60)}` })
      return res.status(401).json({ ok: false, error: 'Неверный e-mail или пароль' })
    }
    await clockIn(user.id) // учёт рабочего времени (§8.1): старт сессии труда
    await appendAudit({ action: 'user.login', module: 'auth', initiator: user.email, reason: `Вход: ${user.name}`, meta: { userId: user.id, roleIds: userRoleIds(user) } })
    res.json({ ok: true, ...(await sessionPayload(user)) })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Самостоятельная регистрация с лендинга.
 *
 * Заводит юзера БЕЗ ролей — то есть без доступа к модулям, пока админ не выдаст его
 * вручную (фокус-группа: «зарегался → админ дал бесплатно на его аккаунты»). Сразу
 * логиним (возвращаем токен), чтобы человек попал в кабинет и ждал выдачи, а не входил
 * повторно. Пароль/почта проверяются в createUser (scrypt-хэш, уникальность e-mail).
 */
usersRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {}
    const user = await createUser({ email, password, name, roleIds: [], active: true })
    await appendAudit({ action: 'user.register', module: 'auth', initiator: user.email, reason: `Регистрация: ${user.name}`, meta: { userId: user.id } })
    const pub = publicUser(user)
    res.json({ ok: true, ...(await sessionPayload(pub)) })
  } catch (err) { fail(res, err, 400) }
})

/**
 * Кто я сейчас — с АКТУАЛЬНЫМИ правами.
 *
 * Права снимались снимком при входе и лежали в localStorage: админ выдавал роли
 * доступ к модулю, а человек продолжал видеть «Нет доступа к разделу», пока не
 * перезайдёт — и никакой подсказки об этом не было. Отзыв доступа так же
 * не срабатывал до перелогина, что уже вопрос безопасности, а не удобства.
 */
usersRouter.get('/me', async (req, res) => {
  try {
    const userId = req.header('x-user-id')
    if (!userId) return res.status(401).json({ ok: false, error: 'Нет сессии' })
    const user = await getUser(userId)
    if (!user || !user.active) return res.status(401).json({ ok: false, error: 'Пользователь отключён' })
    const ids = userRoleIds(user)
    const roles = await rolesForUser(user)
    const isAdmin = hasAdminRole(ids)
    const permissions = isAdmin || roles.length === 0 ? null : mergePermissions(roles)
    const role = { id: user.roleId || '', name: roles.map((r) => r.name).join(' + '), permissions }
    res.json({ ok: true, user: publicUser(user), role, roles })
  } catch (err) { fail(res, err, 500) }
})

/** Выход: закрыть сессию рабочего времени. */
usersRouter.post('/logout', async (req, res) => {
  try {
    const { userId } = req.body ?? {}
    const closed = userId ? await clockOut(userId) : null
    if (closed) await appendAudit({ action: 'user.logout', module: 'auth', initiator: userId, reason: 'Выход', meta: { userId, durationMs: closed.durationMs } })
    res.json({ ok: true, session: closed })
  } catch (err) { fail(res, err, 500) }
})

/** Сводка рабочего времени по всем пользователям (§8.1). */
usersRouter.get('/worktime', async (_req, res) => {
  try {
    const users = await listUsers()
    res.json({ ok: true, worktime: await summariesFor(users.map((u) => u.id)) })
  } catch (err) { fail(res, err, 500) }
})

usersRouter.post('/', async (req, res) => {
  try {
    const user = await createUser(req.body ?? {})
    await appendAudit({ action: 'user.create', module: 'rbac', initiator: 'operator', reason: `Создан пользователь ${user.email}`, meta: { userId: user.id, roleId: user.roleId } })
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) { fail(res, err) }
})

usersRouter.put('/:id', async (req, res) => {
  try {
    const user = await updateUser(req.params.id, req.body ?? {})
    if (!user) return res.status(404).json({ ok: false, error: 'Пользователь не найден' })
    await appendAudit({ action: 'user.update', module: 'rbac', initiator: 'operator', reason: `Изменён пользователь ${user.email}`, meta: { userId: user.id, roleId: user.roleId } })
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) { fail(res, err) }
})

usersRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteUser(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Пользователь не найден' })
    await appendAudit({ action: 'user.delete', module: 'rbac', initiator: 'operator', reason: 'Удалён пользователь', meta: { userId: req.params.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
