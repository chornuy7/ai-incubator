import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
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
import { agentsRouter } from './agentsRoutes.js'
import { leadsRouter } from './leadsRoutes.js'
import { accountGroupsRouter } from './accountGroupsRoutes.js'
import { campaignsRouter } from './campaignsRoutes.js'
import { channelsRouter } from './channelsRoutes.js'
import { rolesRouter } from './rolesRoutes.js'
import { usersRouter } from './usersRoutes.js'
import { moduleAccessGuard, moduleKeyFromModulesPath, isAdminRequest } from './lib/accessGuard.js'
import { proxiesRouter } from './proxiesRoutes.js'
import { importRouter } from './importRoutes.js'
import { getSettings, updateSettings } from './settings.js'
import { appendAudit } from './lib/auditLog.js'
import { startScheduler } from './automation/scheduler.js'
import { loadAiSettings } from './aiSettings.js'
import { loadAiSafety } from './aiSafety.js'
import { loadBlacklist } from './targetBlacklist.js'
import {
  getAllAccountLocks,
  getAllAccountLocksDetailed,
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

app.get('/api/tg/accounts', async (req, res) => {
  try {
    // ?verify=1 — сходить в Telegram за каждым аккаунтом. Долго (подключение на аккаунт),
    // поэтому только по явному запросу: обычный список отдаётся из meta мгновенно.
    const accounts = await tgListAccounts({ verify: req.query.verify === '1' || req.query.verify === 'true' })
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
  res.json({ ok: true, busy: await getAllAccountLocksDetailed() })
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
app.use('/api/agents', agentsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/account-groups', accountGroupsRouter) // §12: группы аккаунтов
app.use('/api/campaigns', campaignsRouter)
app.use('/api/channels', channelsRouter)
app.use('/api/roles', rolesRouter)
app.use('/api/users', usersRouter)
app.use('/api/proxies', proxiesRouter)
app.use('/api/tg/import', importRouter) // §2: массовый импорт аккаунтов

// §6: настройки безопасности. Читать может кто угодно (фронту нужен порог, чтобы
// предупредить заранее), менять — только админ.
app.get('/api/settings', async (_req, res) => {
  try { res.json({ ok: true, settings: await getSettings() }) }
  catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
app.put('/api/settings', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Менять настройки безопасности может только админ' })
    const settings = await updateSettings(req.body ?? {})
    await appendAudit({
      action: 'settings.update', module: 'settings', initiator: req.header('x-user-id') || 'operator',
      reason: `Изменены настройки: ${Object.keys(req.body ?? {}).join(', ')}`, meta: settings,
    }).catch(() => {})
    res.json({ ok: true, settings })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

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

const { flipped, cleared } = await reconcileStaleTasksOnBoot()
if (flipped.length) {
  console.log(`Reconcile: ${flipped.length} устаревших задач помечены stopped, блокировки не восстановлены`)
}
if (cleared?.length) {
  console.log(`Reconcile: ${cleared.length} аккаунтов сняты с зависшего статуса «в работе»`)
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
  const runTrust = () => refreshAllTrustCache().then((r) => { if (r.updated) console.log(`[trust] обновлён кэш trust: ${r.updated} акк.${r.returned ? ` · авто-возврат из прогрева: ${r.returned}` : ''}`) }).catch((e) => console.warn('[trust] refresh failed:', e?.message || e))
  await runTrust()
  setInterval(runTrust, 10 * 60 * 1000)
} catch (err) {
  console.warn('[trust] scheduler init failed:', err)
}

// §6 (прокси): авто-проверка живости прокси при старте + каждые 30 мин.
try {
  const { checkAllProxies } = await import('./proxies.js')
  const runProxy = () => checkAllProxies()
    .then((r) => r.length && console.log(`[proxy] проверено ${r.length}: рабочих ${r.filter((x) => x.status === 'ok').length}, не тот протокол ${r.filter((x) => x.status === 'bad').length}, мёртвых ${r.filter((x) => x.status === 'dead').length}`))
    .catch((e) => console.warn('[proxy] check failed:', e?.message || e))
  // БЕЗ await: проверка ходит наружу через каждый прокси и на полусотне занимает минуты.
  // Раньше это был мгновенный TCP-пинг, и ожидание ничего не стоило; теперь оно
  // задерживало app.listen, то есть API не отвечал, пока не опросятся все прокси.
  void runProxy()
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

// Прод-режим: отдаём собранный фронт (dist/) тем же процессом — один порт на весь сайт.
// Включается автоматически, если рядом есть dist (после `npm run build`). SPA-fallback:
// любой не-/api GET отдаёт index.html, чтобы работали прямые ссылки вида /panel/tasks/:id.
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
  console.log(`[web] статика фронта: ${DIST_DIR}`)
}

// Безопасный дефолт: слушаем только localhost (управление TG-аккаунтами без auth не должно
// торчать в LAN/интернет). Для доступа с другого устройства выставить API_HOST=0.0.0.0.
// На проде держим 127.0.0.1 и выпускаем наружу через nginx с паролем (см. docs/DEPLOY.md).
const HOST = process.env.API_HOST || '127.0.0.1'

/**
 * Ловим то, что иначе роняет процесс молча.
 *
 * 21.07 бэкенд умер без единой строки в логе — снаружи это выглядело как «фронт
 * отдаёт 500», и на поиск причины ушёл час. Воркеры живут в этом же процессе и
 * полны асинхронных операций с сетью, поэтому необработанный reject здесь — норма
 * жизни, а не исключительная ситуация. Пишем и продолжаем: убить задачи из-за
 * одной сорвавшейся отправки хуже, чем доработать в неидеальном состоянии.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] необработанный reject:', reason instanceof Error ? reason.stack : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[fatal] необработанное исключение:', err?.stack || err)
})

const server = app.listen(PORT, HOST, () => {
  console.log(`API → http://${HOST}:${PORT}`)
})
// Занятый порт — единственная ошибка, при которой продолжать бессмысленно: обычно
// это уже запущенный второй экземпляр. Говорим об этом человеческим языком.
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[fatal] порт ${PORT} уже занят — вероятно, бэкенд уже запущен. Остановите старый процесс и повторите.`)
    process.exit(1)
  }
  console.error('[fatal] сервер не поднялся:', err?.stack || err)
  process.exit(1)
})
