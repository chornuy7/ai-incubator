/**
 * Оркестрация кампании (§3.9): один запуск → несколько модулей на общий пул аккаунтов, к одной цели.
 * Монтируется в /api/campaigns.
 */
import { Router } from 'express'
import crypto from 'crypto'
import { buildCampaignPlan } from './lib/campaign.js'
import { validateSettings, startModuleTask } from './modules/registry.js'
import { startWorker } from './modules/workers.js'
import { releaseTaskLocks } from './lib/accountLocks.js'
import { assertAccountsAssignable } from './accountsMeta.js'
import { assertNoHotLeadConflict } from './leads.js'
import { appendAudit } from './lib/auditLog.js'
import { listSchedules, createSchedule, updateSchedule, deleteSchedule } from './campaignSchedules.js'
import { listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign, pinnedAccountMap, conflictingAccounts } from './campaigns.js'

export const campaignsRouter = Router()

/**
 * Запустить кампанию: один план → задачи по модулям на общий пул. Переиспользуется
 * из /launch и из планировщика расписаний. @param {object} body
 * @returns {Promise<{ campaignId:string, tasks:object[], skipped:object[] }>}
 */
export async function runCampaign(body = {}) {
  const initiator = body.initiator || 'operator'
  const plan = buildCampaignPlan({ ...body, initiator })
  if (!plan.length) throw new Error('Выберите хотя бы один модуль')

  const campaignId = `camp_${crypto.randomUUID().slice(0, 8)}`
  const tasks = []
  const skipped = []

  for (const { moduleKey, settings } of plan) {
    if (!settings.accountIds.length) { skipped.push({ moduleKey, reason: 'нет аккаунтов после распределения' }); continue }
    const err = validateSettings(moduleKey, settings)
    if (err) { skipped.push({ moduleKey, reason: err }); continue }
    const assignErr = await assertAccountsAssignable(settings.accountIds, moduleKey)
    if (assignErr) { skipped.push({ moduleKey, reason: assignErr }); continue }
    const hotErr = await assertNoHotLeadConflict(settings.accountIds, moduleKey)
    if (hotErr) { skipped.push({ moduleKey, reason: hotErr }); continue }

    let taskRef
    try {
      const { store, task, worker } = startModuleTask(moduleKey, settings)
      taskRef = task
      task.initiator = initiator
      task.goalId = settings.goalId ?? null
      task.campaignId = campaignId
      await store.saveTask(task)
      startWorker(task.id, store, worker)
      await appendAudit({
        action: 'campaign.task.start',
        module: moduleKey,
        initiator,
        scope: { taskId: task.id, campaignId, goalId: settings.goalId, accounts: settings.accountIds },
        reason: `Кампания ${campaignId}`,
      }).catch(() => {})
      tasks.push({ moduleKey, taskId: task.id, accounts: settings.accountIds.length })
    } catch (e) {
      if (taskRef?.id) releaseTaskLocks(taskRef.id)
      skipped.push({ moduleKey, reason: e instanceof Error ? e.message : 'ошибка запуска' })
    }
  }
  return { campaignId, tasks, skipped }
}

campaignsRouter.post('/launch', async (req, res) => {
  try {
    // §11.1: если фронт не передал инициатора явно — берём из сессии (заголовок),
    // чтобы запуск кампании был привязан к человеку, а не к обезличенному 'operator'.
    const { campaignId, tasks, skipped } = await runCampaign({
      ...(req.body ?? {}),
      initiator: req.body?.initiator || req.header('x-user-id') || undefined,
    })
    if (!tasks.length) return res.status(409).json({ ok: false, error: 'Ни один модуль не запущен', skipped })
    res.json({ ok: true, campaignId, tasks, skipped })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// ── Расписание кампаний (§3.9): запланировать + вкл/выкл + повтор ──
function fail(res, err, code = 400) { res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }

// Аудит 20.08: расписания кампаний отдавались все всем (владелец у них уже пишется).
campaignsRouter.get('/schedules', async (req, res) => {
  try {
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    res.json({ ok: true, schedules: await ownedForRequest(req, await listSchedules()) })
  } catch (e) { fail(res, e, 500) }
})
campaignsRouter.post('/schedules', async (req, res) => {
  try {
    const sched = await createSchedule({ ...(req.body ?? {}), userId: req.header('x-user-id') || '' })
    // §11.1: пишем РЕАЛЬНОГО инициатора — обезличенный 'operator' не привязывается
    // к человеку, и событие пропадает из журнала активности юзера в админке.
    await appendAudit({ action: 'campaign.schedule.create', module: 'campaign', initiator: req.header('x-user-id') || 'operator', reason: `Запланирована кампания «${sched.name}»`, meta: { scheduleId: sched.id, runAt: sched.runAt, repeat: sched.repeat } })
    res.json({ ok: true, schedule: sched })
  } catch (e) { fail(res, e) }
})
campaignsRouter.put('/schedules/:id', async (req, res) => {
  try {
    const sched = await updateSchedule(req.params.id, req.body ?? {})
    if (!sched) return res.status(404).json({ ok: false, error: 'Расписание не найдено' })
    res.json({ ok: true, schedule: sched })
  } catch (e) { fail(res, e) }
})
campaignsRouter.delete('/schedules/:id', async (req, res) => {
  try {
    const ok = await deleteSchedule(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Расписание не найдено' })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

// ── §5: CRUD сущности «Кампания». ВАЖНО: объявлено ПОСЛЕ /schedules и /launch,
// иначе '/:id' затенил бы их. ──────────────────────────────────────────────────

campaignsRouter.get('/', async (req, res) => {
  try {
    const { goalId, status, moduleKey } = req.query
    // Аудит 20.08: кампании отдавались все всем. Владелец пишется (ownerColumn) — фильтруем.
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    const campaigns = await ownedForRequest(req, await listCampaigns({ goalId, status, moduleKey }))
    res.json({ ok: true, campaigns, pinned: pinnedAccountMap(campaigns) })
  } catch (e) { fail(res, e) }
})

/** §5: аккаунт закреплён кампанией → не отдаём его другой (выходит из общего пула). */
async function assertAccountsFree(accountIds, selfId) {
  if (!accountIds?.length) return null
  const busy = conflictingAccounts(pinnedAccountMap(await listCampaigns()), accountIds, selfId)
  if (!busy.length) return null
  return `Аккаунты закреплены за другой кампанией: ${busy.map((x) => String(x).slice(-6)).join(', ')}. Освободите их или снимите закрепление.`
}

campaignsRouter.post('/', async (req, res) => {
  try {
    const body = req.body ?? {}
    if (body.pinned !== false) {
      const err = await assertAccountsFree(body.accountIds)
      if (err) return res.status(409).json({ ok: false, error: err })
    }
    // §11.3: кампания привязывается к создателю (x-user-id ставит sessionGuard из подписанной сессии).
    res.json({ ok: true, campaign: await createCampaign({ ...body, userId: body.userId || req.header('x-user-id') || '' }) })
  } catch (e) { fail(res, e) }
})

campaignsRouter.get('/:id', async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Кампания не найдена' })
    res.json({ ok: true, campaign })
  } catch (e) { fail(res, e) }
})

campaignsRouter.put('/:id', async (req, res) => {
  try {
    const body = req.body ?? {}
    if (body.accountIds && body.pinned !== false) {
      const err = await assertAccountsFree(body.accountIds, req.params.id)
      if (err) return res.status(409).json({ ok: false, error: err })
    }
    const campaign = await updateCampaign(req.params.id, body)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Кампания не найдена' })
    res.json({ ok: true, campaign })
  } catch (e) { fail(res, e) }
})

campaignsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteCampaign(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Кампания не найдена' })
    res.json({ ok: true }) // удаление кампании освобождает её аккаунты (лок жил в самой кампании)
  } catch (e) { fail(res, e) }
})
