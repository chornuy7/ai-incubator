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
import { appendAudit } from './lib/auditLog.js'

export const campaignsRouter = Router()

campaignsRouter.post('/launch', async (req, res) => {
  try {
    const body = req.body ?? {}
    const initiator = body.initiator || 'operator'
    const plan = buildCampaignPlan({ ...body, initiator })
    if (!plan.length) return res.status(400).json({ ok: false, error: 'Выберите хотя бы один модуль' })

    const campaignId = `camp_${crypto.randomUUID().slice(0, 8)}`
    const tasks = []
    const skipped = []

    for (const { moduleKey, settings } of plan) {
      if (!settings.accountIds.length) { skipped.push({ moduleKey, reason: 'нет аккаунтов после распределения' }); continue }
      const err = validateSettings(moduleKey, settings)
      if (err) { skipped.push({ moduleKey, reason: err }); continue }
      const assignErr = await assertAccountsAssignable(settings.accountIds, moduleKey)
      if (assignErr) { skipped.push({ moduleKey, reason: assignErr }); continue }

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

    if (!tasks.length) return res.status(409).json({ ok: false, error: 'Ни один модуль не запущен', skipped })
    res.json({ ok: true, campaignId, tasks, skipped })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
