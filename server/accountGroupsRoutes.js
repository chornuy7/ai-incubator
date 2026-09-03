/** §12: роуты групп (папок) аккаунтов. Монтируется в /api/account-groups. */
import { Router } from 'express'
import { listGroups, getGroup, createGroup, updateGroup, deleteGroup, groupsByAccount } from './accountGroups.js'
import { requesterContext, ownedForRequest, ownsRecord } from './lib/accessGuard.js'

export const accountGroupsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/**
 * §5.4 (MR-37): владелец правит только СВОИ группы. GET оставляем полным — список групп
 * нужен для резолва доступа (какой аккаунт виден через группу) и на клиенте, и на сервере;
 * защищаем изменение/удаление. Раньше правку групп не проверял никто (гейт был во фронте).
 */
async function guardOwnGroup(req, res) {
  const ctx = await requesterContext(req)
  if (ctx.noSession || ctx.isAdmin) return true
  if (ctx.blocked) { res.status(403).json({ ok: false, error: 'Нет прав' }); return false }
  const group = await getGroup(req.params.id)
  if (!group) { res.status(404).json({ ok: false, error: 'Группа не найдена' }); return false }
  if (group.userId && group.userId !== ctx.id) { res.status(403).json({ ok: false, error: 'Можно менять только свои группы' }); return false }
  return true
}

// Аудит 20.08: группы аккаунтов отдавались все всем — фильтруем по владельцу пространства.
accountGroupsRouter.get('/', async (req, res) => {
  try {
    const groups = await ownedForRequest(req, await listGroups())
    res.json({ ok: true, groups, byAccount: groupsByAccount(groups) })
  } catch (e) { fail(res, e, 500) }
})

accountGroupsRouter.post('/', async (req, res) => {
  try { res.json({ ok: true, group: await createGroup({ ...(req.body ?? {}), userId: req.header('x-user-id') || '' }) }) } catch (e) { fail(res, e) }
})

// Аудит 21.08: правку групп закрыли ещё в MR-37, а чтение по id осталось открытым —
// и отдавало СОСТАВ чужой группы, то есть id чужих Telegram-аккаунтов. Список групп
// уже фильтруется по владельцу, точечное чтение приводим к тому же правилу.
accountGroupsRouter.get('/:id', async (req, res) => {
  try {
    const group = await getGroup(req.params.id)
    if (!group) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    if (!(await ownsRecord(req, group))) return res.status(403).json({ ok: false, error: 'Это не ваша группа' })
    res.json({ ok: true, group })
  } catch (e) { fail(res, e, 500) }
})

accountGroupsRouter.put('/:id', async (req, res) => {
  try {
    if (!(await guardOwnGroup(req, res))) return
    const group = await updateGroup(req.params.id, req.body ?? {})
    if (!group) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    res.json({ ok: true, group })
  } catch (e) { fail(res, e) }
})

accountGroupsRouter.delete('/:id', async (req, res) => {
  try {
    if (!(await guardOwnGroup(req, res))) return
    const ok = await deleteGroup(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})
