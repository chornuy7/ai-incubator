/** CRUD-роуты RBAC (§8.1). Монтируется в /api/roles. */
import { Router } from 'express'
import { listRoles, getRole, createRole, updateRole, deleteRole, buildCatalog } from './roles.js'
import { appendAudit } from './lib/auditLog.js'

export const rolesRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

rolesRouter.get('/', async (_req, res) => {
  try {
    res.json({ ok: true, roles: await listRoles() })
  } catch (err) { fail(res, err, 500) }
})

/** Каталог грантов (модули/блоки/ресурсы) — до :id, иначе перехватит /:id. */
rolesRouter.get('/catalog', async (_req, res) => {
  try {
    res.json({ ok: true, catalog: await buildCatalog() })
  } catch (err) { fail(res, err, 500) }
})

rolesRouter.get('/:id', async (req, res) => {
  try {
    const role = await getRole(req.params.id)
    if (!role) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    res.json({ ok: true, role })
  } catch (err) { fail(res, err, 500) }
})

rolesRouter.post('/', async (req, res) => {
  try {
    const role = await createRole(req.body ?? {})
    await appendAudit({ action: 'role.create', module: 'rbac', initiator: 'operator', reason: `Создана роль «${role.name}»`, meta: { roleId: role.id } })
    res.json({ ok: true, role })
  } catch (err) { fail(res, err) }
})

rolesRouter.put('/:id', async (req, res) => {
  try {
    const role = await updateRole(req.params.id, req.body ?? {})
    if (!role) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    await appendAudit({ action: 'role.update', module: 'rbac', initiator: 'operator', reason: `Изменена роль «${role.name}»`, meta: { roleId: role.id } })
    res.json({ ok: true, role })
  } catch (err) { fail(res, err) }
})

rolesRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteRole(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    await appendAudit({ action: 'role.delete', module: 'rbac', initiator: 'operator', reason: 'Удалена роль', meta: { roleId: req.params.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
