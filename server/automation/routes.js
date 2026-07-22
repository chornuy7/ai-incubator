import { Router } from 'express'
import { listRules, createRule, updateRule, deleteRule } from './store.js'
import { runRuleNow } from './scheduler.js'
import { appendAudit } from '../lib/auditLog.js'

export const automationRouter = Router()

const fail = (res, err, code = 400) =>
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })

/**
 * §3.1: расписание запускает работу без участия оператора, а его удаление необратимо —
 * и то и другое должно оставлять след. Раньше этот роут не писал в журнал ничего
 * (прогон 21–22.07, тест 13.4). Аудит best-effort: не роняет операцию.
 */
const audit = (req, action, reason, rule) =>
  appendAudit({
    action,
    module: 'automation',
    initiator: req.header('x-user-id') || 'operator',
    reason,
    scope: { ruleId: rule?.id, ...(rule?.accountIds?.length ? { accounts: rule.accountIds } : {}) },
    meta: { moduleKey: rule?.moduleKey, schedule: rule?.schedule, enabled: rule?.enabled },
  }).catch(() => {})

/** Человекочитаемое расписание для строки журнала. @param {*} s */
const schedText = (s) =>
  s?.type === 'once' ? `один раз ${new Date(s.at).toLocaleString('ru-RU')}`
    : s?.type === 'daily' ? `ежедневно в ${s.time}`
      : s?.type === 'interval' ? `каждые ${s.intervalMinutes} мин`
        : '—'

automationRouter.get('/rules', async (_req, res) => {
  try {
    res.json({ ok: true, rules: await listRules() })
  } catch (err) { fail(res, err, 500) }
})

automationRouter.post('/rules', async (req, res) => {
  try {
    const body = req.body ?? {}
    // §6: правило крепится к кампании ИЛИ (legacy) к модулю с явными аккаунтами.
    if (!body.campaignId && !body.moduleKey) {
      return res.status(400).json({ ok: false, error: 'Выберите кампанию (или модуль) — автоматизировать ненастроенный модуль нельзя' })
    }
    if (!body.campaignId && (!Array.isArray(body.accountIds) || !body.accountIds.length)) {
      return res.status(400).json({ ok: false, error: 'Выберите хотя бы один аккаунт' })
    }
    const rule = await createRule(body)
    await audit(req, 'automation.create', `Создано расписание «${rule.name}» (${rule.moduleKey}): ${schedText(rule.schedule)}`, rule)
    res.json({ ok: true, rule })
  } catch (err) { fail(res, err) }
})

automationRouter.put('/rules/:id', async (req, res) => {
  try {
    const before = (await listRules()).find((r) => r.id === req.params.id)
    const rule = await updateRule(req.params.id, req.body ?? {})
    if (!rule) return res.status(404).json({ ok: false, error: 'Правило не найдено' })
    const changed = before && schedText(before.schedule) !== schedText(rule.schedule)
      ? `${schedText(before.schedule)} → ${schedText(rule.schedule)}`
      : 'правка полей'
    await audit(req, 'automation.update', `Расписание «${rule.name}»: ${changed}`, rule)
    res.json({ ok: true, rule })
  } catch (err) { fail(res, err) }
})

automationRouter.delete('/rules/:id', async (req, res) => {
  try {
    const before = (await listRules()).find((r) => r.id === req.params.id)
    const ok = await deleteRule(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Правило не найдено' })
    await audit(req, 'automation.delete', `Удалено расписание «${before?.name ?? req.params.id}» (${schedText(before?.schedule)})`, before)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

automationRouter.post('/rules/:id/run', async (req, res) => {
  try {
    const rule = (await listRules()).find((r) => r.id === req.params.id)
    const taskId = await runRuleNow(req.params.id)
    await audit(req, 'automation.run', `Досрочный запуск расписания «${rule?.name ?? req.params.id}» → задача ${taskId}`, rule)
    res.json({ ok: true, taskId })
  } catch (err) { fail(res, err) }
})
