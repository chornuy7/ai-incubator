/** CRM-роуты «Лиды» (§3.6). Монтируется в /api/leads. */
import { Router } from 'express'
import { listLeads, createLead, updateLead, deleteLead, upsertLead, leadStats, LEAD_STATUSES } from './leads.js'
import { loadMessages } from './neuroDialogs/service.js'
import { getAccountMeta } from './accountsMeta.js'
import { getAccountLock } from './lib/accountLocks.js'
import { outgoingToPeer } from './lib/outbox.js'
import { appendAudit } from './lib/auditLog.js'
import { ownerScopeForRequest, ownsRecord, canSeeAccount } from './lib/accessGuard.js'

export const leadsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/*
 * Аудит 21.08: этот роутер смонтирован вообще без гейта и отдавал CRM ВСЕЙ платформы —
 * контакты людей, статусы воронки, заметки менеджеров. Хуже того, из чужого лида брались
 * `accountId` и `peer`, и `/conversation` шёл ими в Telegram: цепочка «список лидов →
 * чужой аккаунт → чтение личной переписки» замыкалась целиком внутри нашего API.
 *
 * Поэтому здесь две разные проверки, и обе нужны:
 *   • владелец записи (`ownsRecord`) — чей это лид в CRM;
 *   • доступ к аккаунту (`canSeeAccount`) — чьими руками мы лезем в Telegram.
 * Вторая не выводится из первой: лида можно завести с любым `accountId` в теле запроса.
 */
const denyLead = (res) => res.status(403).json({ ok: false, error: 'Это не ваш лид' })

/** Лид по id — только если он мой. `null` = не найден, `false` = чужой. */
async function myLead(req, id) {
  const lead = (await listLeads()).find((l) => l.id === id)
  if (!lead) return null
  return (await ownsRecord(req, lead)) ? lead : false
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
    const { goalId, campaignId, taskId, status, accountId } = req.query
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const filter = { goalId, campaignId, taskId, status, accountId }
    // Админ и дев-режим видят всё (scope.all) — остальным подмешиваем владельца.
    if (!scope.all) filter.userId = scope.ownerId
    res.json({ ok: true, statuses: LEAD_STATUSES, leads: await listLeads(filter) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.get('/stats', async (req, res) => {
  try {
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    res.json({ ok: true, stats: await leadStats(req.query.goalId, scope.all ? '' : scope.ownerId) })
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
    // Аккаунт приходит из запроса, а не из лида, — значит проверяем именно его: иначе
    // подставив чужой id, любой прочитал бы личную переписку чужого профиля.
    if (!(await canSeeAccount(req, String(accountId)))) {
      return res.status(403).json({ ok: false, error: 'Это не ваш аккаунт' })
    }
    const scope = await ownerScopeForRequest(req)
    const mine = scope.all ? {} : { userId: scope.ownerId }
    const lead = (await listLeads(mine)).find((l) => l.peer === peer && l.accountId === accountId) || null
    res.json({ ok: true, lead, ...(await readConversation(String(accountId), String(peer), readLimit(req.query))) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.get('/:id/conversation', async (req, res) => {
  try {
    const lead = await myLead(req, req.params.id)
    if (lead === false) return denyLead(res)
    if (!lead) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    if (!lead.accountId) return res.status(400).json({ ok: false, error: 'У лида не указан аккаунт — некому открыть переписку' })
    // Мало того, что лид мой: открывать переписку можно только доступным мне аккаунтом.
    // За лидом мог остаться аккаунт, который уже передали другому — или сотрудник видит
    // лида, но не тот профиль, которым с ним говорили.
    if (!(await canSeeAccount(req, String(lead.accountId)))) {
      return res.status(403).json({ ok: false, error: 'Переписка велась аккаунтом, к которому у вас нет доступа' })
    }
    if (!lead.peer) return res.status(400).json({ ok: false, error: 'У лида не указан контакт' })
    res.json({ ok: true, lead, ...(await readConversation(lead.accountId, lead.peer, readLimit(req.query))) })
  } catch (err) { fail(res, err, 500) }
})

leadsRouter.post('/', async (req, res) => {
  try {
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    // Владелец — из сессии, а не из тела запроса: иначе лид можно было бы подбросить
    // в чужую CRM (и вместе с ним — чужой контакт в чужую воронку).
    const lead = await createLead({ ...(req.body ?? {}), userId: scope.ownerId || undefined })
    await audit(req, 'lead.create', `Лид ${lead.peer} добавлен вручную (${lead.status})`, lead)
    res.json({ ok: true, lead })
  } catch (err) { fail(res, err) }
})

// §9: авто-попадание лида в CRM — upsert по (goalId+peer), статус только вперёд.
leadsRouter.post('/upsert', async (req, res) => {
  try {
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    res.json({ ok: true, ...(await upsertLead({ ...(req.body ?? {}), userId: scope.ownerId || undefined })) })
  } catch (err) { fail(res, err) }
})

leadsRouter.put('/:id', async (req, res) => {
  try {
    const before = await myLead(req, req.params.id)
    if (before === false) return denyLead(res)
    // Перевесить лида можно только на СВОЙ аккаунт: смена ответственного решает, чьими
    // руками пойдёт диалог дальше, — чужой горячий лид иначе уводился бы себе.
    const nextAccount = (req.body ?? {}).accountId
    if (nextAccount && !(await canSeeAccount(req, String(nextAccount)))) {
      return res.status(403).json({ ok: false, error: 'Это не ваш аккаунт' })
    }
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
    const before = await myLead(req, req.params.id)
    if (before === false) return denyLead(res)
    const ok = await deleteLead(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Лид не найден' })
    await audit(req, 'lead.delete', `Лид ${before?.peer ?? req.params.id} удалён из CRM (был ${before?.status ?? '—'})`, before)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
