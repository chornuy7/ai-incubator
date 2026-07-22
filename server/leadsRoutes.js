/** CRM-роуты «Лиды» (§3.6). Монтируется в /api/leads. */
import { Router } from 'express'
import { listLeads, createLead, updateLead, deleteLead, upsertLead, leadStats, LEAD_STATUSES } from './leads.js'
import { appendAudit } from './lib/auditLog.js'

export const leadsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/**
 * §3.1: след в журнале для ручных операций с CRM. Аудит best-effort — он не должен
 * ронять саму операцию, поэтому ошибки глотаем.
 * Раньше здесь не было ни одного вызова: перепривязка ответственного аккаунта и
 * удаление лида проходили бесследно (прогон 21–22.07, тест 13.4).
 */
const audit = (req, action, reason, lead) =>
  appendAudit({
    action,
    module: 'leads',
    initiator: req.header('x-user-id') || 'operator',
    reason,
    account: lead?.accountId || undefined,
    scope: { leadId: lead?.id, ...(lead?.accountId ? { accounts: [lead.accountId] } : {}) },
    meta: { peer: lead?.peer, status: lead?.status },
  }).catch(() => {})

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
    const lead = await createLead(req.body ?? {})
    await audit(req, 'lead.create', `Лид ${lead.peer} добавлен вручную (${lead.status})`, lead)
    res.json({ ok: true, lead })
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
    const before = (await listLeads()).find((l) => l.id === req.params.id)
    const lead = await updateLead(req.params.id, req.body ?? {})
    if (!lead) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    // Смена ответственного аккаунта решает, кто ведёт диалог, — это стоит писать отдельно.
    const parts = []
    if (before && before.status !== lead.status) parts.push(`статус ${before.status} → ${lead.status}`)
    if (before && (before.accountId || null) !== (lead.accountId || null)) {
      parts.push(`ответственный ${before.accountId ? String(before.accountId).slice(-6) : '—'} → ${lead.accountId ? String(lead.accountId).slice(-6) : '—'}`)
    }
    await audit(req, 'lead.update', `Лид ${lead.peer}: ${parts.join(', ') || 'правка полей'}`, lead)
    res.json({ ok: true, lead })
  } catch (err) { fail(res, err) }
})

leadsRouter.delete('/:id', async (req, res) => {
  try {
    const before = (await listLeads()).find((l) => l.id === req.params.id)
    const ok = await deleteLead(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    await audit(req, 'lead.delete', `Лид ${before?.peer ?? req.params.id} удалён из CRM (был ${before?.status ?? '—'})`, before)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
