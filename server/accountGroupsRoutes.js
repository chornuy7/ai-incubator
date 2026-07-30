/** §12: роуты групп (папок) аккаунтов. Монтируется в /api/account-groups. */
import { Router } from 'express'
import { listGroups, getGroup, createGroup, updateGroup, deleteGroup, groupsByAccount } from './accountGroups.js'

export const accountGroupsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

accountGroupsRouter.get('/', async (_req, res) => {
  try {
    const groups = await listGroups()
    res.json({ ok: true, groups, byAccount: groupsByAccount(groups) })
  } catch (e) { fail(res, e, 500) }
})

accountGroupsRouter.post('/', async (req, res) => {
  try { res.json({ ok: true, group: await createGroup({ ...(req.body ?? {}), userId: req.header('x-user-id') || '' }) }) } catch (e) { fail(res, e) }
})

accountGroupsRouter.get('/:id', async (req, res) => {
  try {
    const group = await getGroup(req.params.id)
    if (!group) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    res.json({ ok: true, group })
  } catch (e) { fail(res, e, 500) }
})

accountGroupsRouter.put('/:id', async (req, res) => {
  try {
    const group = await updateGroup(req.params.id, req.body ?? {})
    if (!group) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    res.json({ ok: true, group })
  } catch (e) { fail(res, e) }
})

accountGroupsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteGroup(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Группа не найдена' })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})
