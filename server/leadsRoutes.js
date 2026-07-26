/** CRM-роуты «Лиды» (§3.6). Монтируется в /api/leads. */
import { Router } from 'express'
import { listLeads, createLead, updateLead, deleteLead, upsertLead, leadStats, LEAD_STATUSES } from './leads.js'
import { loadMessages } from './neuroDialogs/service.js'
import { getAccountMeta } from './accountsMeta.js'
import { getAccountLock } from './lib/accountLocks.js'
import { outgoingToPeer } from './lib/outbox.js'
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
    const { goalId, campaignId, status, accountId } = req.query
    res.json({ ok: true, statuses: LEAD_STATUSES, leads: await listLeads({ goalId, campaignId, status, accountId }) })
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
async function readConversation(accountId, rawPeer, limit) {
  const meta = await getAccountMeta(accountId)
  // Аккаунт может быть занят задачей: чтение истории лёгкое и не мешает работе,
  // но человеку стоит знать, что он смотрит переписку прямо во время рассылки.
  const lock = getAccountLock(accountId)
  // Контакт хранится по-разному: «@username», числовой id или отображаемое имя.
  // Резолверу диалогов юзернейм надо отдать отдельным полем, иначе он ищет его как id
  // и не находит вообще ничего.
  const peer = String(rawPeer).replace(/^\+/, '')
  const bare = peer.replace(/^@/, '')
  const isUsername = /^[a-zA-Z][\w\d_]{3,}$/.test(bare)
  const messages = await loadMessages(accountId, bare, limit, 0, isUsername ? { username: bare } : {})
  // Telegram отдал пустой диалог, а мы точно писали? Значит отправку стёр антиспам:
  // сообщение исчезает у обеих сторон, диалога в списке нет. Показать «переписки нет»
  // было бы враньём — человек решит, что баг у нас, вместо того чтобы увидеть
  // главный симптом помеченного аккаунта.
  const wiped = !messages?.messages?.length ? await outgoingToPeer(rawPeer, { accountId }) : []
  return {
    account: { id: accountId, name: meta.name || accountId, status: meta.status || 'active' },
    busyIn: lock ? { moduleLabel: lock.moduleLabel, taskId: lock.taskId } : null,
    messages,
    wiped,
  }
}

const readLimit = (q) => Math.min(200, Math.max(1, Number(q.limit) || 60))

/**
 * Переписка по контакту напрямую — для тех, кто ещё не стал лидом (получатели рассылки
 * без цели, например). Аккаунт обязателен: у каждого своя история диалога.
 * Объявлено ДО '/:id/conversation', иначе «conversation» уедет в параметр `id`.
 */
leadsRouter.get('/conversation', async (req, res) => {
  try {
    const { peer, accountId } = req.query
    if (!peer) return res.status(400).json({ ok: false, error: 'Укажите контакт' })
    if (!accountId) return res.status(400).json({ ok: false, error: 'Укажите аккаунт, которым велась переписка' })
    const lead = (await listLeads()).find((l) => l.peer === peer && l.accountId === accountId) || null
    res.json({ ok: true, lead, ...(await readConversation(String(accountId), String(peer), readLimit(req.query))) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.get('/:id/conversation', async (req, res) => {
  try {
    const lead = (await listLeads()).find((l) => l.id === req.params.id)
    if (!lead) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    if (!lead.accountId) return res.status(400).json({ ok: false, error: 'У лида не указан аккаунт — некому открыть переписку' })
    if (!lead.peer) return res.status(400).json({ ok: false, error: 'У лида не указан контакт' })
    res.json({ ok: true, lead, ...(await readConversation(lead.accountId, lead.peer, readLimit(req.query))) })
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
