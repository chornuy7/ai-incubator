/** CRUD-роуты RBAC (§8.1). Монтируется в /api/roles. */
import { Router } from 'express'
import { listRoles, getRole, createRole, updateRole, deleteRole, buildCatalog, ADMIN_ROLE_ID } from './roles.js'
import { requesterContext } from './lib/accessGuard.js'
import { appendAudit } from './lib/auditLog.js'

export const rolesRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

rolesRouter.get('/', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    const roles = await listRoles()
    // §4.1/§5.3 (MR-29): владелец видит системные роли-шаблоны (без user_id) + СВОИ созданные;
    // админ-роль ему не показываем (эскалация), админ/дев — все роли.
    const visible = (ctx.noSession || ctx.isAdmin)
      ? roles
      : roles.filter((r) => r.id !== ADMIN_ROLE_ID && (!r.userId || r.userId === ctx.id))
    res.json({ ok: true, roles: visible })
  } catch (err) { fail(res, err, 500) }
})

/** Каталог грантов (модули/блоки/ресурсы) — до :id, иначе перехватит /:id. */
rolesRouter.get('/catalog', async (req, res) => {
  try {
    // Владельцу показываем ТОЛЬКО оплаченные им модули (решение 21.08), админу и деву —
    // весь список. Иначе владелец «выдавал» бы роли на чужие модули: роль сохранялась,
    // а запуск всё равно падал на подписке — доступ, которого нет.
    const ctx = await requesterContext(req)
    let limit = null
    if (!ctx.noSession && !ctx.isAdmin) {
      const { getBalance, subscriptionExpired } = await import('./balance.js')
      const b = await getBalance(ctx.id)
      // Истёкшая подписка — пустой каталог: раздавать доступ к остановленным модулям
      // бессмысленно, а молча показать их — обещать работу, которой не будет.
      limit = { modules: subscriptionExpired(b.expiresAt) ? [] : b.modules }
    }
    res.json({ ok: true, catalog: await buildCatalog(limit) })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Не дать роли выдать модуль вне подписки того, кто её правит.
 *
 * Каталог уже показывает только своё, но форму можно обойти (прямой запрос), а цена
 * ошибки — «доступ выдан» на бумаге и отказ при запуске. Правило то же, что в гейте:
 * есть в наборе и срок не вышел.
 * @returns {Promise<string|null>} текст ошибки или null
 */
async function outsideSubscription(ctx, permissions) {
  if (ctx.noSession || ctx.isAdmin) return null
  const wanted = Object.entries(permissions?.modules || {})
    .filter(([, v]) => v === 'allow')
    .map(([k]) => k)
  if (!wanted.length) return null
  const { getBalance, modulesAllow } = await import('./balance.js')
  const b = await getBalance(ctx.id)
  const outside = wanted.filter((k) => !modulesAllow(b.modules, k, b.expiresAt ?? null))
  if (!outside.length) return null
  return `Нельзя выдать доступ к тому, что не оплачено: ${outside.join(', ')}. Добавьте модуль в свою подписку.`
}

rolesRouter.get('/:id', async (req, res) => {
  try {
    const role = await getRole(req.params.id)
    if (!role) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    res.json({ ok: true, role })
  } catch (err) { fail(res, err, 500) }
})

/**
 * §11.3: держать `user_types`/`user_type_modules` в согласии с ролями.
 *
 * Синхронизируем ПОСЛЕ ответа и best-effort: таблицы типов — проекция для БД и отчётов,
 * гейт доступа читает roles.permissions. Если проекция не обновится, доступы не поедут,
 * поэтому падение синка не должно валить сохранение роли.
 */
function resyncTypes() {
  void import('./lib/typesSync.js')
    .then(async (m) => { await m.syncTypesAndModules(); await m.syncModuleLinks() })
    .catch((e) => console.warn('[types] синхронизация после правки роли не удалась:', e?.message || e))
}

rolesRouter.post('/', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    const denied = await outsideSubscription(ctx, req.body?.permissions)
    if (denied) return res.status(403).json({ ok: false, error: denied })
    // §11.3: кто создал роль (личность из подписанной сессии).
    const role = await createRole({ ...(req.body ?? {}), userId: req.header('x-user-id') || '' })
    await appendAudit({ action: 'role.create', module: 'rbac', initiator: req.header('x-user-id') || 'operator', reason: `Создана роль «${role.name}»`, meta: { roleId: role.id } })
    resyncTypes()
    res.json({ ok: true, role })
  } catch (err) { fail(res, err) }
})

rolesRouter.put('/:id', async (req, res) => {
  try {
    // §4.1 (MR-29): владелец правит только свои роли; шаблоны/чужие/админ — только sudo.
    const ctx = await requesterContext(req)
    if (!ctx.noSession && !ctx.isAdmin) {
      const target = await getRole(req.params.id)
      if (!target || target.userId !== ctx.id) return res.status(403).json({ ok: false, error: 'Можно менять только свои роли' })
    }
    const denied = await outsideSubscription(ctx, req.body?.permissions)
    if (denied) return res.status(403).json({ ok: false, error: denied })
    const role = await updateRole(req.params.id, req.body ?? {})
    if (!role) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    await appendAudit({ action: 'role.update', module: 'rbac', initiator: req.header('x-user-id') || 'operator', reason: `Изменена роль «${role.name}»`, meta: { roleId: role.id } })
    resyncTypes()
    res.json({ ok: true, role })
  } catch (err) { fail(res, err) }
})

rolesRouter.delete('/:id', async (req, res) => {
  try {
    // §4.1 (MR-29): владелец удаляет только свои роли.
    const ctx = await requesterContext(req)
    if (!ctx.noSession && !ctx.isAdmin) {
      const target = await getRole(req.params.id)
      if (!target || target.userId !== ctx.id) return res.status(403).json({ ok: false, error: 'Можно удалять только свои роли' })
    }
    const ok = await deleteRole(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Роль не найдена' })
    await appendAudit({ action: 'role.delete', module: 'rbac', initiator: req.header('x-user-id') || 'operator', reason: 'Удалена роль', meta: { roleId: req.params.id } })
    resyncTypes()
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
