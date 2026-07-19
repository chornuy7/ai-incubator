/** CRM-роуты «Лиды» (§3.6). Монтируется в /api/leads. */
import { Router } from 'express'
import { listLeads, createLead, updateLead, deleteLead, upsertLead, leadStats, LEAD_STATUSES } from './leads.js'

export const leadsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

leadsRouter.get('/', async (req, res) => {
  try {
    const { goalId, status, accountId } = req.query
    res.json({ ok: true, statuses: LEAD_STATUSES, leads: await listLeads({ goalId, status, accountId }) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.get('/stats', async (req, res) => {
  try {
    res.json({ ok: true, stats: await leadStats(req.query.goalId) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.post('/', async (req, res) => {
  try {
    res.json({ ok: true, lead: await createLead(req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

// §9: авто-попадание лида в CRM — upsert по (goalId+peer), статус только вперёд.
leadsRouter.post('/upsert', async (req, res) => {
  try {
    res.json({ ok: true, ...(await upsertLead(req.body ?? {})) })
  } catch (err) { fail(res, err) }
})

leadsRouter.put('/:id', async (req, res) => {
  try {
    const lead = await updateLead(req.params.id, req.body ?? {})
    if (!lead) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    res.json({ ok: true, lead })
  } catch (err) { fail(res, err) }
})

leadsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteLead(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
