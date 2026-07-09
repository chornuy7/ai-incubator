import { Router } from 'express'
import { listRules, createRule, updateRule, deleteRule } from './store.js'
import { runRuleNow } from './scheduler.js'

export const automationRouter = Router()

const fail = (res, err, code = 400) =>
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })

automationRouter.get('/rules', async (_req, res) => {
  try {
    res.json({ ok: true, rules: await listRules() })
  } catch (err) { fail(res, err, 500) }
})

automationRouter.post('/rules', async (req, res) => {
  try {
    const body = req.body ?? {}
    if (!body.moduleKey) return res.status(400).json({ ok: false, error: 'Выберите модуль' })
    if (!Array.isArray(body.accountIds) || !body.accountIds.length) {
      return res.status(400).json({ ok: false, error: 'Выберите хотя бы один аккаунт' })
    }
    res.json({ ok: true, rule: await createRule(body) })
  } catch (err) { fail(res, err) }
})

automationRouter.put('/rules/:id', async (req, res) => {
  try {
    const rule = await updateRule(req.params.id, req.body ?? {})
    if (!rule) return res.status(404).json({ ok: false, error: 'Правило не найдено' })
    res.json({ ok: true, rule })
  } catch (err) { fail(res, err) }
})

automationRouter.delete('/rules/:id', async (req, res) => {
  try {
    const ok = await deleteRule(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Правило не найдено' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

automationRouter.post('/rules/:id/run', async (req, res) => {
  try {
    const taskId = await runRuleNow(req.params.id)
    res.json({ ok: true, taskId })
  } catch (err) { fail(res, err) }
})
