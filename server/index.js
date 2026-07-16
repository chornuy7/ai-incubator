import express from 'express'
import cors from 'cors'
import { PORT } from './config.js'
import { tgSendCode, tgVerifyCode, tgVerify2fa, tgCheckSession } from './tgAuth.js'
import { tgListAccounts, tgPatchAccount, tgDeleteAccount, tgEmptyTrash } from './tgAccounts.js'
import { neuroCommentingRouter } from './neuroCommenting/routes.js'
import { neuroDialogsRouter } from './neuroDialogs/routes.js'
import { modulesRouter } from './modules/routes.js'
import { tgstatRouter } from './tgstat/router.js'
import { answerHelp } from './aiHelp.js'
import { featureRouter } from './featureRoutes.js'
import { automationRouter } from './automation/routes.js'
import { goalsRouter } from './goalsRoutes.js'
import { leadsRouter } from './leadsRoutes.js'
import { campaignsRouter } from './campaignsRoutes.js'
import { channelsRouter } from './channelsRoutes.js'
import { rolesRouter } from './rolesRoutes.js'
import { usersRouter } from './usersRoutes.js'
import { moduleAccessGuard, moduleKeyFromModulesPath } from './lib/accessGuard.js'
import { proxiesRouter } from './proxiesRoutes.js'
import { startScheduler } from './automation/scheduler.js'
import { loadAiSettings } from './aiSettings.js'
import { loadAiSafety } from './aiSafety.js'
import { loadBlacklist } from './targetBlacklist.js'
import {
  getAllAccountLocks,
  reconcileStaleTasksOnBoot,
  reconcileLocks,
  forceReleaseAccount,
} from './lib/accountLocks.js'
import { buildAccountStats, listAccountChannels, listAccountFolders } from './accountStats.js'
import { dailySummary, dailySummaryAll } from './lib/dailyActions.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ai-incubator-api',
    ai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    aiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  })
})

app.get('/api/tg/accounts', async (_req, res) => {
  try {
    const accounts = await tgListAccounts()
    res.json({ ok: true, accounts })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.patch('/api/tg/accounts/:accountId', async (req, res) => {
  try {
    const patch = req.body ?? {}
    // Перенос между ролями/проектами — зафиксировать инициатора в аудите (§3.2/§4).
    let before = null
    if (patch.role !== undefined || patch.project !== undefined) {
      const { getAccountMeta } = await import('./accountsMeta.js')
      before = await getAccountMeta(req.params.accountId)
    }
    const account = await tgPatchAccount(req.params.accountId, patch)
    if (before) {
      const changes = {}
      if (patch.role !== undefined && patch.role !== before.role) changes.role = { from: before.role, to: patch.role }
      if (patch.project !== undefined && patch.project !== before.project) changes.project = { from: before.project, to: patch.project }
      if (Object.keys(changes).length) {
        const { appendAudit } = await import('./lib/auditLog.js')
        await appendAudit({
          action: 'account.transfer',
          module: 'accounts',
          initiator: patch.initiator || 'operator',
          account: req.params.accountId,
          scope: { accounts: [req.params.accountId] },
          meta: changes,
        }).catch(() => {})
      }
    }
    res.json({ ok: true, account })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.delete('/api/tg/accounts/:accountId', async (req, res) => {
  try {
    await tgDeleteAccount(req.params.accountId)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/tg/accounts/empty-trash', async (_req, res) => {
  try {
    const count = await tgEmptyTrash()
    res.json({ ok: true, count })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/tg/send-code', async (req, res) => {
  try {
    const { phone, proxy, accountId } = req.body ?? {}
    const result = await tgSendCode({ phone, proxy, accountId })
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/tg/verify-code', async (req, res) => {
  try {
    const { authId, code } = req.body ?? {}
    const result = await tgVerifyCode({ authId, code })
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/tg/verify-2fa', async (req, res) => {
  try {
    const { authId, password } = req.body ?? {}
    const result = await tgVerify2fa({ authId, password })
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/session/:accountId', async (req, res) => {
  try {
    const result = await tgCheckSession(req.params.accountId)
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/accounts/busy', async (_req, res) => {
  // Самолечение: снять блокировки, чьи задачи уже не выполняются на диске / в процессе.
  try {
    await reconcileLocks()
  } catch { /* ignore */ }
  res.json({ ok: true, busy: getAllAccountLocks() })
})

app.get('/api/tg/accounts/daily-all', async (_req, res) => {
  try {
    res.json({ ok: true, daily: await dailySummaryAll() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/accounts/:accountId/stats', async (req, res) => {
  try {
    const spam = req.query.spam === '1' || req.query.spam === 'true'
    const stats = await buildAccountStats(req.params.accountId, { spam })
    res.json({ ok: true, stats })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/accounts/:accountId/daily', async (req, res) => {
  try {
    const summary = await dailySummary(req.params.accountId)
    res.json({ ok: true, daily: summary })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/accounts/:accountId/channels', async (req, res) => {
  try {
    const result = await listAccountChannels(req.params.accountId)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.get('/api/tg/accounts/:accountId/folders', async (req, res) => {
  try {
    const result = await listAccountFolders(req.params.accountId)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/tg/accounts/:accountId/release', async (req, res) => {
  const released = forceReleaseAccount(req.params.accountId)
  res.json({ ok: true, released: released ? { taskId: released.taskId, moduleLabel: released.moduleLabel } : null })
})

// Ручное управление статусом оператором (§3.3 pause / §4 аудит инициатора). Только безопасный whitelist.
app.post('/api/tg/accounts/:accountId/status', async (req, res) => {
  try {
    const { to, initiator } = req.body ?? {}
    if (!['pause', 'active'].includes(to)) {
      return res.status(400).json({ ok: false, error: 'Недопустимое ручное действие статуса (только pause/active)' })
    }
    const { setAccountStatus } = await import('./accountsMeta.js')
    await setAccountStatus(req.params.accountId, to, {
      initiator: initiator || 'operator',
      module: 'accounts',
      code: 'MANUAL',
      reason: to === 'pause' ? 'Ручная пауза оператором' : 'Снятие паузы оператором',
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

app.post('/api/modules/locks/reconcile', async (_req, res) => {
  try {
    const dropped = await reconcileLocks()
    res.json({ ok: true, dropped })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// RBAC-гейт (§8.1): доступ к модулю по роли из заголовка X-User-Id (см. accessGuard.js)
app.use('/api/neuro-commenting', moduleAccessGuard(() => 'neuro-commenting'), neuroCommentingRouter)
app.use('/api/neuro-dialogs', moduleAccessGuard(() => 'neuro-dialogs'), neuroDialogsRouter)
app.use('/api/modules', moduleAccessGuard(moduleKeyFromModulesPath), modulesRouter)
app.use('/api/tgstat', tgstatRouter)

// AI-помощник Help Center
app.post('/api/ai/help', async (req, res) => {
  try {
    const { topic, context, question, history } = req.body || {}
    if (!question || !String(question).trim()) return res.status(400).json({ ok: false, error: 'Пустой вопрос' })
    const { answer, mode } = await answerHelp({ topic, context, question, history })
    res.json({ ok: true, answer, mode })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
app.use('/api/automation', automationRouter)
app.use('/api/goals', goalsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/channels', channelsRouter)
app.use('/api/roles', rolesRouter)
app.use('/api/users', usersRouter)
app.use('/api/proxies', proxiesRouter)

// Единый журнал действий/аудит (§3.1/§5): смена статусов, старт/стоп задач, перенос, кампании.
app.get('/api/audit', async (req, res) => {
  try {
    const { readAudit } = await import('./lib/auditLog.js')
    const { limit, action, initiator, account } = req.query
    const entries = await readAudit({ limit: limit ? Number(limit) : 300, action, initiator, account })
    res.json({ ok: true, entries })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
app.use('/api', featureRouter)

// Загружаем кэши глобальных настроек (промпт, ИИ-безопасность, ЧС) до старта воркеров.
await Promise.all([
  loadAiSettings().catch(() => {}),
  loadAiSafety().catch(() => {}),
  loadBlacklist().catch(() => {}),
])

const { flipped } = await reconcileStaleTasksOnBoot()
if (flipped.length) {
  console.log(`Reconcile: ${flipped.length} устаревших задач помечены stopped, блокировки не восстановлены`)
}

// Авто-выход из временных статусов (floodwait/quarantine с истёкшим сроком) на старте (§3.3).
try {
  const { reconcileExpiredStatuses } = await import('./accountsMeta.js')
  const back = await reconcileExpiredStatuses()
  if (back.length) console.log(`Reconcile статусов: ${back.length} аккаунтов вернулись из временного статуса`)
} catch (err) {
  console.warn('[status] reconcileExpiredStatuses failed:', err)
}

await startScheduler().catch((err) => console.warn('[automation] scheduler init failed:', err))

// §3.3: держим кэш trust свежим (без сети) — чтобы assignment-gate и список были актуальны.
try {
  const { refreshAllTrustCache } = await import('./accountStats.js')
  const runTrust = () => refreshAllTrustCache().then((n) => n && console.log(`[trust] обновлён кэш trust: ${n} акк.`)).catch((e) => console.warn('[trust] refresh failed:', e?.message || e))
  await runTrust()
  setInterval(runTrust, 10 * 60 * 1000)
} catch (err) {
  console.warn('[trust] scheduler init failed:', err)
}

// §6 (прокси): авто-проверка живости прокси при старте + каждые 30 мин.
try {
  const { checkAllProxies } = await import('./proxies.js')
  const runProxy = () => checkAllProxies().then((r) => r.length && console.log(`[proxy] проверено ${r.length}, живых ${r.filter((x) => x.status === 'ok').length}`)).catch((e) => console.warn('[proxy] check failed:', e?.message || e))
  await runProxy()
  setInterval(runProxy, 30 * 60 * 1000)
} catch (err) {
  console.warn('[proxy] scheduler init failed:', err)
}

// Авто-обновление статистики каналов (§3.9, решение 14.07: день / час-если-бот-в-группе).
try {
  const { startChannelStatsScheduler } = await import('./channelStats.js')
  startChannelStatsScheduler()
} catch (err) {
  console.warn('[stats] scheduler init failed:', err)
}

// Планировщик кампаний по расписанию (§3.9): каждую минуту запускает «созревшие».
try {
  const { campaignScheduleTick } = await import('./campaignSchedules.js')
  const { runCampaign } = await import('./campaignsRoutes.js')
  const tick = () => campaignScheduleTick(runCampaign).then((fired) => {
    if (fired.length) console.log(`[campaigns] запущено по расписанию: ${fired.length}`)
  }).catch((err) => console.warn('[campaigns] schedule tick failed:', err))
  setInterval(tick, 60 * 1000)
  console.log('[campaigns] планировщик расписаний включён')
} catch (err) {
  console.warn('[campaigns] schedule scheduler init failed:', err)
}

// Безопасный дефолт: слушаем только localhost (управление TG-аккаунтами без auth не должно
// торчать в LAN/интернет). Для доступа с другого устройства выставить API_HOST=0.0.0.0.
const HOST = process.env.API_HOST || '127.0.0.1'
app.listen(PORT, HOST, () => {
  console.log(`API → http://${HOST}:${PORT}`)
})
