/** CRUD + аутентификация операторов (§8.1). Монтируется в /api/users. */
import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, authenticate, publicUser } from './users.js'
import { getRole } from './roles.js'
import { appendAudit } from './lib/auditLog.js'

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
    const role = user.roleId ? await getRole(user.roleId) : null
    await appendAudit({ action: 'user.login', module: 'auth', initiator: user.email, reason: `Вход: ${user.name}`, meta: { userId: user.id, roleId: user.roleId } })
    res.json({ ok: true, user, role })
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
