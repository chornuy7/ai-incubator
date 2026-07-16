/** CRUD + аутентификация операторов (§8.1). Монтируется в /api/users. */
import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, authenticate, publicUser } from './users.js'
import { rolesForUser, mergePermissions, userRoleIds, hasAdminRole } from './roles.js'
import { appendAudit } from './lib/auditLog.js'
import { clockIn, clockOut, summariesFor } from './workLog.js'

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

/** Логин: возвращает публичного юзера + его роль (с правами) для гейтинга UI. */
usersRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {}
    const user = await authenticate(email, password)
    if (!user) {
      await appendAudit({ action: 'user.login.fail', module: 'auth', initiator: 'system', reason: `Неудачный вход: ${String(email || '').slice(0, 60)}` })
      return res.status(401).json({ ok: false, error: 'Неверный e-mail или пароль' })
    }
    // Мульти-роль: объединяем права всех ролей пользователя (union). Админ среди ролей → bypass.
    const ids = userRoleIds(user)
    const roles = await rolesForUser(user)
    const isAdmin = hasAdminRole(ids)
    // Админ или нет разрешимых ролей → null (bypass/не гейтим, как прежде); иначе — union прав.
    const permissions = isAdmin || roles.length === 0 ? null : mergePermissions(roles)
    const roleName = roles.map((r) => r.name).join(' + ')
    const role = { id: user.roleId || '', name: roleName, permissions }
    await clockIn(user.id) // учёт рабочего времени (§8.1): старт сессии труда
    await appendAudit({ action: 'user.login', module: 'auth', initiator: user.email, reason: `Вход: ${user.name}`, meta: { userId: user.id, roleIds: ids } })
    res.json({ ok: true, user, role, roles })
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
