/** CRM-роуты «Лиды» (§3.6). Монтируется в /api/leads. */
import { Router } from 'express'
import { listLeads, createLead, updateLead, deleteLead, upsertLead, leadStats, LEAD_STATUSES } from './leads.js'
import { loadMessages } from './neuroDialogs/service.js'
import { getAccountMeta } from './accountsMeta.js'
import { getAccountLock } from './lib/accountLocks.js'

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

/**
 * Переписка по лиду: как реально шёл диалог с этим человеком.
 *
 * Читаем НЕ из логов задачи, а из самого Telegram аккаунтом-владельцем лида — логи
 * показывают только то, что писали мы, а понять разговор можно лишь целиком.
 * Работает и для лидов, заведённых до появления этого экрана.
 */
leadsRouter.get('/:id/conversation', async (req, res) => {
  try {
    const lead = (await listLeads()).find((l) => l.id === req.params.id)
    if (!lead) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    if (!lead.accountId) return res.status(400).json({ ok: false, error: 'У лида не указан аккаунт — некому открыть переписку' })
    if (!lead.peer) return res.status(400).json({ ok: false, error: 'У лида не указан контакт' })

    const meta = await getAccountMeta(lead.accountId)
    // Аккаунт может быть занят задачей: чтение истории лёгкое и не мешает работе,
    // но человеку стоит знать, что он смотрит переписку прямо во время рассылки.
    const lock = getAccountLock(lead.accountId)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60))
    // `peer` у лида хранится по-разному: «@username», числовой id или отображаемое имя.
    // Резолверу диалогов юзернейм надо отдать отдельным полем, иначе он ищет его как id
    // и не находит вообще ничего.
    const peer = String(lead.peer)
    const isUsername = /^@?[a-zA-Z][\w\d_]{3,}$/.test(peer) && !/^\d+$/.test(peer)
    const messages = await loadMessages(
      lead.accountId,
      peer.replace(/^@/, ''),
      limit,
      0,
      isUsername ? { username: peer.replace(/^@/, '') } : {},
    )
    res.json({
      ok: true,
      lead,
      account: { id: lead.accountId, name: meta.name || lead.accountId, status: meta.status || 'active' },
      busyIn: lock ? { moduleLabel: lock.moduleLabel, taskId: lock.taskId } : null,
      messages,
    })
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
