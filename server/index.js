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

// Продакшн-замок: личность из подписанного токена, при SESSION_SECRET — вход обязателен.
// Монтируется ДО всех /api-роутов, чтобы RBAC ниже работал на доверенной личности.
const { sessionGuard } = await import('./lib/authGuard.js')
app.use('/api', sessionGuard)

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
  // §9.12: тот же барьер, что и в модулях. Массовый «Стоп / освободить» в менеджере
  // снимал локи напрямую и обходил защиту прогрева: остановить недели работы можно
  // было в два клика из списка аккаунтов, хотя в самом модуле это запрещено.
  const { WARMING_MODULES, canStopWarming } = await import('./lib/safetyLimits.js')
  const { getAccountLock } = await import('./lib/accountLocks.js')
  const info = getAccountLock(req.params.accountId)
  if (info && WARMING_MODULES.has(info.moduleKey) && !canStopWarming(await isAdminRequest(req))) {
    return res.status(403).json({
      ok: false,
      error: 'Останавливать прогрев может только супер-админ: это недели работы аккаунтов, откатить нельзя.',
    })
  }
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
    const { answer, mode } = await answerHelp({ topic, context, question, history, userId: req.header('x-user-id') })
    res.json({ ok: true, answer, mode })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
app.use('/api/automation', automationRouter)
app.use('/api/goals', goalsRouter)
app.use('/api/agents', agentsRouter)
app.use('/api/leads', leadsRouter)

/** §10.3: управление API-ключами «мозгов» — только владелец. */
app.get('/api/admin/api-keys', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Ключи видит только владелец' })
    const { listKeys } = await import('./apiKeys.js')
    res.json({ ok: true, keys: await listKeys() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.post('/api/admin/api-keys', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Выпускать ключи может только владелец' })
    const { issueKey } = await import('./apiKeys.js')
    const key = await issueKey({ name: req.body?.name, userId: req.body?.userId })
    await appendAudit({ action: 'apikey.issue', module: 'api', initiator: req.header('x-user-id') || 'system', reason: `Выпущен ключ «${key.name}» для пользователя ${key.ownerId}`, meta: { id: key.id, userId: key.ownerId } }).catch(() => {})
    res.json({ ok: true, key }) // ПОЛНЫЙ ключ — единственный раз
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.delete('/api/admin/api-keys/:id', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Отзывать ключи может только владелец' })
    const { revokeKey } = await import('./apiKeys.js')
    const gone = await revokeKey(req.params.id)
    if (!gone) return res.status(404).json({ ok: false, error: 'Ключ не найден' })
    await appendAudit({ action: 'apikey.revoke', module: 'api', initiator: req.header('x-user-id') || 'system', reason: `Отозван ключ ${req.params.id}` }).catch(() => {})
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §10.3: публичный API v1 для внешнего AI-оркестратора (закрытый ключ внутри роутера).
const { apiV1Router } = await import('./apiV1.js')
app.use('/api/v1', apiV1Router)
app.use('/api/account-groups', accountGroupsRouter) // §12: группы аккаунтов
app.use('/api/campaigns', campaignsRouter)
app.use('/api/channels', channelsRouter)
app.use('/api/roles', rolesRouter)
app.use('/api/users', usersRouter)
app.use('/api/proxies', proxiesRouter)
app.use('/api/tg/import', importRouter) // §2: массовый импорт аккаунтов

// §2.4 (D5): кампания принимает намерение СЛОВАМИ, система предлагает раскладку.
// Заказчик: «я хочу создать кампанию, а не настроить модуль». Отдаём ПРЕДЛОЖЕНИЕ —
// оператор видит, что система поняла, и правит; молча разложить чужое намерение
// по боевым модулям было бы опасно.
app.post('/api/campaigns/intent', async (req, res) => {
  try {
    const { parseIntent } = await import('./lib/intent.js')
    res.json({ ok: true, suggestion: parseIntent(req.body?.text || '') })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §1.3 (C3): счётчик переходов. Короткая ссылка живёт в корне (`/r/<code>`), а не
// под /api — её отправляют людям, и она должна выглядеть как ссылка, а не как вызов API.
app.get('/r/:code', async (req, res) => {
  try {
    const { registerHit } = await import('./linkTracker.js')
    const url = await registerHit(req.params.code, {
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      ua: req.headers['user-agent'] || '',
      ref: req.headers.referer || '',
    })
    if (!url) return res.status(404).send('Ссылка не найдена')
    // 302, а не 301: постоянный редирект браузер закеширует, и следующие переходы
    // того же человека мы просто не увидим — счётчик замрёт.
    return res.redirect(302, url)
  } catch {
    return res.status(500).send('Ошибка перехода')
  }
})

app.get('/api/links', async (req, res) => {
  try {
    const { listLinks, goalHits } = await import('./linkTracker.js')
    const links = await listLinks()
    const goalId = req.query.goalId ? String(req.query.goalId) : null
    res.json({
      ok: true,
      links: goalId ? links.filter((l) => l.goalId === goalId) : links,
      ...(goalId ? { summary: await goalHits(goalId) } : {}),
    })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
app.post('/api/links', async (req, res) => {
  try {
    const { createLink } = await import('./linkTracker.js')
    const link = await createLink(req.body ?? {})
    await appendAudit({
      action: 'link.create', module: 'links', initiator: req.header('x-user-id') || 'operator',
      reason: `Создана отслеживаемая ссылка на ${link.url}`, scope: { goalId: link.goalId },
    }).catch(() => {})
    res.json({ ok: true, link })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
app.delete('/api/links/:id', async (req, res) => {
  try {
    const { deleteLink } = await import('./linkTracker.js')
    const ok = await deleteLink(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Ссылка не найдена' })
    res.json({ ok: true })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §5.3 (E1/E2): сводная статистика админ-панели и постатейный отчёт клиенту.
// Только админ: это данные по всем пользователям и деньгам, а не по своей работе.
app.get('/api/admin/overview', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { adminOverview } = await import('./adminStats.js')
    res.json({ ok: true, overview: await adminOverview({ since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
/**
 * Что делал конкретный аккаунт: задачи, действия, токены, деньги, лиды.
 *
 * Гейт ЗДЕСЬ, а не «выше по цепочке» — выше его нет. Отдаём только тем, кому этот
 * аккаунт доступен по правам: иначе любой запрос вытаскивал бы по чужому профилю
 * список задач, потраченные деньги и число лидов — ровно то, что закрывает §8.1.
 * Несуществующий id тоже отбиваем: без этого 200 с нулями подтверждал бы перебор.
 */
app.get('/api/accounts/:accountId/work', async (req, res) => {
  try {
    const id = String(req.params.accountId || '')
    const { loadAllMeta } = await import('./accountsMeta.js')
    const meta = await loadAllMeta().catch(() => ({}))
    if (!meta || !meta[id]) return res.status(404).json({ ok: false, error: 'Аккаунт не найден' })

    const { canSeeAccount } = await import('./lib/accessGuard.js')
    if (!(await canSeeAccount(req, id))) {
      return res.status(403).json({ ok: false, error: 'Нет доступа к этому аккаунту' })
    }

    const { accountReport } = await import('./adminStats.js')
    const rep = await accountReport(id, { since: req.query.since ? Number(req.query.since) : undefined })
    res.json({ ok: true, work: rep })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3: где сейчас болит — ошибки задач, баны, работа вставшая из-за денег. */
app.get('/api/admin/problems', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { problems } = await import('./adminStats.js')
    res.json({ ok: true, problems: await problems({ since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.4: наборы, которые админ собирает под клиента («парсер + комментинг за 20 $»).
 * Только владелец: это цены, по которым пространство продаёт.
 */
app.post('/api/bundles', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Собирать наборы может только владелец' })
    const { createBundle } = await import('./bundles.js')
    // §11.3: кто собрал набор.
    const bundle = await createBundle({ ...(req.body || {}), userId: req.header('x-user-id') || '' })
    await appendAudit({
      action: 'bundle.create', module: 'billing', initiator: req.header('x-user-id') || 'system',
      reason: `Набор «${bundle.name}»: ${bundle.modules.length} модулей за ${bundle.price}`,
      meta: bundle,
    }).catch(() => {})
    res.json({ ok: true, bundle })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.delete('/api/bundles/:id', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Удалять наборы может только владелец' })
    const { deleteBundle } = await import('./bundles.js')
    const gone = await deleteBundle(req.params.id)
    if (!gone) return res.status(404).json({ ok: false, error: 'Набор не найден' })
    await appendAudit({
      action: 'bundle.delete', module: 'billing', initiator: req.header('x-user-id') || 'system',
      reason: `Удалён набор ${req.params.id}`,
    }).catch(() => {})
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §10.4: цены — из БД, не из кода. Читать эффективные цены может любой (витрине
 * они и так видны), МЕНЯТЬ — только владелец: это выручка пространства.
 */
app.get('/api/admin/prices', async (req, res) => {
  try {
    const { effectivePrices } = await import('./priceStore.js')
    res.json({ ok: true, prices: await effectivePrices() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.patch('/api/admin/prices', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Менять цены может только владелец' })
    const { setOverrides } = await import('./priceStore.js')
    const prices = await setOverrides(req.body || {})
    await appendAudit({
      action: 'prices.update', module: 'billing', initiator: req.header('x-user-id') || 'system',
      reason: 'Изменены цены из админки',
      meta: { patch: req.body },
    }).catch(() => {})
    res.json({ ok: true, prices })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3: кто работает прямо сейчас — запущенные и вставшие задачи. */
app.get('/api/admin/active', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { activeNow } = await import('./adminStats.js')
    res.json({ ok: true, active: await activeNow() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3: расход по дням — тренд, а не только итог за период. */
app.get('/api/admin/daily', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { dailySpend } = await import('./adminStats.js')
    res.json({ ok: true, daily: await dailySpend({ days: req.query.days ? Number(req.query.days) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3 + CRM: воронка лидов, горячие и зависшие. */
app.get('/api/admin/crm', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { crmOverview } = await import('./adminStats.js')
    res.json({ ok: true, crm: await crmOverview({ stuckDays: req.query.stuckDays ? Number(req.query.stuckDays) : undefined, since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3: статистика по людям — кто сколько запустил и сколько с него списано. */
app.get('/api/admin/users-report', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { usersReport } = await import('./adminStats.js')
    res.json({ ok: true, report: await usersReport({ since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.1: журнал активности конкретного юзера — что делал, когда, с какого IP.
 * Только админ: это инструмент контроля за тем, что происходит внутри нашей
 * экосистемы чужими руками, а не пользовательская фича.
 */
app.get('/api/admin/user-activity', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Журнал доступен только администратору' })
    const userId = String(req.query.userId || '')
    if (!userId) return res.status(400).json({ ok: false, error: 'Нужен userId' })
    const { userActivity } = await import('./adminStats.js')
    res.json({
      ok: true,
      activity: await userActivity({
        userId,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        action: String(req.query.action || ''),
      }),
    })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.1: «с кем переписывается» — диалоги аккаунтов этого юзера. Только админ:
 * это контроль за тем, что делают чужие люди нашими Telegram-аккаунтами.
 */
app.get('/api/admin/user-dialogs', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступно только администратору' })
    const userId = String(req.query.userId || '')
    if (!userId) return res.status(400).json({ ok: false, error: 'Нужен userId' })
    const { userDialogs } = await import('./adminStats.js')
    res.json({ ok: true, dialogs: await userDialogs({ userId }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.3: наполнить таблицы типов и прав из реальных ролей. Только админ.
 * Идемпотентно — можно жать повторно. Гейт доступа при этом не меняется
 * (см. lib/typesSync.js: это проекция модульного среза, а не замена RBAC).
 */
app.post('/api/admin/sync-types', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступно только администратору' })
    const { syncTypesAndModules } = await import('./lib/typesSync.js')
    const report = await syncTypesAndModules()
    await appendAudit({
      action: 'types.sync', module: 'admin', initiator: req.header('x-user-id') || 'system',
      reason: `Синхронизация типов и прав: типов ${report.types || 0}, связей ${report.links || 0}`,
      meta: report,
    }).catch(() => {})
    res.json({ ok: true, report })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.1: сама переписка — реплики по конкретному собеседнику или по юзеру целиком.
 * Только админ: это персональные данные третьих лиц, наружу они не отдаются.
 */
app.get('/api/admin/messages', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступно только администратору' })
    const { listMessages } = await import('./messages.js')
    const rows = await listMessages({
      userId: String(req.query.userId || '') || undefined,
      accountId: String(req.query.accountId || '') || undefined,
      peer: String(req.query.peer || '') || undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
    res.json({ ok: true, messages: rows })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §10.9: здоровье аккаунтов — активные/на паузе/падающие + причина. Только админ. */
app.get('/api/admin/accounts-health', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Мониторинг доступен только администратору' })
    const { accountsHealth } = await import('./adminStats.js')
    res.json({ ok: true, health: await accountsHealth() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** §5.3: что и сколько куплено — пополнения кошельков по людям. Только админ. */
app.get('/api/admin/purchases', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Статистика доступна только администратору' })
    const { purchasesReport } = await import('./adminStats.js')
    res.json({ ok: true, purchases: await purchasesReport({ since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.1: база оплат — все платежи с диапазоном дат (from..to) и пагинацией. Только админ.
 * Индекс пересобирается из источников истины при каждом запросе — витрина не расходится
 * с деньгами. Имена/почты джойним из users на лету (в БД не храним — они меняются).
 */
app.get('/api/admin/payments', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Оплаты доступны только администратору' })
    const { syncPayments, queryPayments, paymentsSummary } = await import('./payments.js')
    await syncPayments()
    const q = req.query
    const opts = {
      from: q.from ? Number(q.from) : 0,
      to: q.to ? Number(q.to) : 0,
      userId: q.userId ? String(q.userId) : '',
      kind: q.kind ? String(q.kind) : '',
      q: q.q ? String(q.q) : '',
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    }
    const { total, rows } = queryPayments(opts)
    const summary = paymentsSummary({ from: opts.from, to: opts.to })
    const { listUsers } = await import('./users.js')
    const users = await listUsers().catch(() => [])
    const nameOf = new Map(users.map((u) => [u.id, u.name || u.email || u.id]))
    const emailOf = new Map(users.map((u) => [u.id, u.email || '']))
    const items = rows.map((r) => ({
      ...r,
      name: nameOf.get(r.user_id) || (r.user_id === '__default' ? 'Системный кошелёк' : r.user_id),
      email: emailOf.get(r.user_id) || '',
    }))
    // §10.4: курс монета→$ для показа $-эквивалента пополнений (реальный $ — с платёжкой).
    // Единый хелпер priceStore, чтобы правило «цена монеты» не дублировалось.
    let coinUsd = 0
    try { const { coinUsdRate } = await import('./priceStore.js'); coinUsd = await coinUsdRate() } catch { /* нет прайса */ }
    res.json({ ok: true, payments: { total, items, summary, limit: opts.limit, offset: opts.offset, coinUsd } })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.3: ЛИЧНАЯ статистика — своя работа и свои расходы. Гейта админа тут нет: это
 * данные самого пользователя, идентифицируем по X-User-Id. Без него (демо/дев)
 * отдаём пусто — фронт в этом случае показывает демо-моки, а не реальный срез.
 */
app.get('/api/me/stats', async (req, res) => {
  try {
    const me = req.header('x-user-id')
    if (!me) return res.status(400).json({ ok: false, error: 'Нет сессии' })
    const { myStats } = await import('./adminStats.js')
    res.json({ ok: true, stats: await myStats(me, { since: req.query.since ? Number(req.query.since) : undefined }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.get('/api/admin/report', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Отчёт доступен только администратору' })
    const { clientReport } = await import('./adminStats.js')
    const report = await clientReport({
      since: req.query.since ? Number(req.query.since) : undefined,
      until: req.query.until ? Number(req.query.until) : undefined,
      userId: req.query.userId ? String(req.query.userId) : undefined,
    })
    res.json({ ok: true, report })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §4 (D1/D2): усталость и распорядок аккаунтов. Читают все — список аккаунтов
// показывает, кто отдыхает. Массовое задание профиля — прямой запрос владельца:
// «чтобы можно было массово всем задавать усталость и отдых от модулей».
app.get('/api/accounts/activity', async (_req, res) => {
  try {
    const { listActivity } = await import('./accountActivity.js')
    res.json({ ok: true, activity: await listActivity() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
// Снятие спамблока через @SpamBot — заводит НАСТОЯЩУЮ фоновую задачу (модуль spam-unblock),
// видна в «Дашборде задач» со своими логами/прогрессом/стопом.
app.post('/api/accounts/unblock', async (req, res) => {
  try {
    const { accountIds, delayMin, delayMax } = req.body ?? {}
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ ok: false, error: 'Выберите аккаунты' })
    const ids = [...new Set(accountIds.map((x) => String(x || '').trim()).filter(Boolean))]
    const { getModuleStore, getWorker } = await import('./modules/registry.js')
    const { startWorker } = await import('./modules/workers.js')
    const store = getModuleStore('spam-unblock')
    // Локи не берём: снятие спамблока — лёгкая сервисная операция, не кампанийное действие,
    // и блокировать 20 аккаунтов ради апелляции в @SpamBot незачем.
    const task = store.createTask({ accountIds: ids, delayMin, delayMax, initiator: req.header('x-user-id') || 'operator' },
      { progress: { done: 0, total: ids.length, actionsDone: 0, cleared: 0 } })
    task.initiator = req.header('x-user-id') || 'operator'
    await store.saveTask(task)
    startWorker(task.id, store, getWorker('spam-unblock'))
    await appendAudit({ action: 'accounts.unblock.start', module: 'accounts', initiator: task.initiator, reason: `Задача снятия спамблока: ${ids.length} акк.`, scope: { accounts: ids, taskId: task.id } }).catch(() => {})
    res.json({ ok: true, taskId: task.id, started: ids.length })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

app.post('/api/accounts/activity', async (req, res) => {
  try {
    const { setActivityProfile, restAccounts } = await import('./accountActivity.js')
    const { accountIds, profile, schedule, spread, reset, restMinutes } = req.body ?? {}
    if (!Array.isArray(accountIds) || !accountIds.length) {
      return res.status(400).json({ ok: false, error: 'Выберите аккаунты' })
    }
    const n = restMinutes !== undefined
      ? await restAccounts(accountIds, restMinutes)
      : await setActivityProfile(accountIds, { profile, schedule, spread, reset })
    await appendAudit({
      action: 'accounts.activity', module: 'accounts', initiator: req.header('x-user-id') || 'operator',
      reason: restMinutes !== undefined
        ? `Отправлены на отдых ${n} акк. на ${restMinutes} мин`
        : schedule
          ? `Распорядок дня задан ${n} акк.${spread === false ? ' (одинаковый)' : ' (со сдвигом по аккаунтам)'}`
          : `Профиль усталости задан ${n} акк.${reset ? ' (усталость сброшена)' : ''}`,
      scope: { accounts: accountIds },
    }).catch(() => {})
    const { listActivity } = await import('./accountActivity.js')
    res.json({ ok: true, applied: n, activity: await listActivity() })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.1: прайс — сколько стоит одно действие каждого модуля. Отдаём с сервера, а не
 * держим копию в вебе: цену утверждает заказчик, и расхождение витрины с тем, что
 * реально спишется, — худший вид ошибки в биллинге.
 */
app.get('/api/pricing', async (_req, res) => {
  try {
    const { CURRENCY } = await import('./pricing.js')
    const { effectivePrices } = await import('./priceStore.js')
    const { tokenSummary } = await import('./tokenLedger.js')
    // Цены действий и пакеты — эффективные (код + правки админки).
    const eff = await effectivePrices()
    // Средний расход токенов на действие — из СВОЕЙ истории, а не из константы:
    // длина промпта и ответа у каждого клиента своя, и чужое среднее врало бы.
    // Нет истории — 0, и интерфейс честно скажет «пока не на чем считать».
    const avgTokens = {}
    for (const key of Object.keys(eff.actionMap)) {
      const sum = await tokenSummary({ module: key }).catch(() => null)
      avgTokens[key] = sum?.calls ? Math.round(sum.tokens / sum.calls) : 0
    }
    const items = eff.modules
      .filter((m) => m.action > 0)
      .map((m) => ({ key: m.key, title: m.title, price: m.action, avgTokens: avgTokens[m.key] || 0 }))
      .sort((a, b) => b.price - a.price || a.title.localeCompare(b.title, 'ru'))
    res.json({
      ok: true, items, actions: eff.actionMap, avgTokens,
      coinsPer1kTokens: eff.coinsPer1kTokens, packs: eff.coinPacks, currency: CURRENCY,
      tokenUsd: eff.tokenUsd, tokenUsdAuto: eff.tokenUsdAuto, tokenUsdComputed: eff.tokenUsdComputed, tokenUsdModel: eff.tokenUsdModel,
      imageMultiplier: eff.imageMultiplier,
    })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.4: витрина подписки — цена каждого модуля в месяц, готовые сетапы и что уже
 * куплено. Считает сервер: витрина и то, что спишется, должны быть одним числом.
 */
app.get('/api/subscription', async (req, res) => {
  try {
    const { SETUPS, CURRENCY, subscriptionCost } = await import('./pricing.js')
    const { getBalance } = await import('./balance.js')
    const { listBundles } = await import('./bundles.js')
    const { effectivePrices } = await import('./priceStore.js')
    const { modules } = await getBalance(req.header('x-user-id'))
    const bundles = await listBundles()
    // Цены — эффективные (код + переопределения из админки), а не константа: правка
    // цены в админке должна тут же менять витрину.
    const eff = await effectivePrices()
    const priceMap = eff.monthMap
    const items = eff.modules
      .map((m) => ({ key: m.key, title: m.title, price: m.month }))
      .sort((a, b) => b.price - a.price || a.title.localeCompare(b.title, 'ru'))
    const setups = [
      ...SETUPS.map((s) => ({ ...s, cost: subscriptionCost(s.modules, bundles, priceMap) })),
      ...bundles.map((b) => {
        const cost = subscriptionCost(b.modules, bundles, priceMap)
        return {
          id: b.id, name: b.name, hint: b.hint, modules: b.modules,
          custom: true, price: b.price,
          // Скидка выводится из цены: «77 вместо 109» — это −29 %, и бейдж обязан
          // так и говорить. Захардкоженный ноль показывал клиенту «−0%».
          discount: cost.full ? Math.max(0, Math.round((1 - cost.sum / cost.full) * 100) / 100) : 0,
          cost,
        }
      }),
    ]
    // §11.2: periods — витрина строит переключатель из них, а не из «месяц/год» в коде.
    res.json({ ok: true, items, setups, currency: CURRENCY, mine: modules, annualDiscount: eff.annualDiscount, periods: eff.periods })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** Сколько будет стоить набор — до оплаты. */
app.post('/api/subscription/quote', async (req, res) => {
  try {
    const { subscriptionCost } = await import('./pricing.js')
    const { listBundles } = await import('./bundles.js')
    const { effectivePrices } = await import('./priceStore.js')
    const eff = await effectivePrices()
    res.json({ ok: true, ...subscriptionCost(req.body?.modules || [], await listBundles(), eff.monthMap) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * Оформить подписку на выбранные модули. Оплаты в демо нет — записываем набор.
 * Когда появится платёжный провайдер, сюда встанет проверка успешного платежа,
 * а всё остальное (гейт запуска, меню) уже работает от этого набора.
 */
app.post('/api/subscription', async (req, res) => {
  try {
    const { setModules } = await import('./balance.js')
    const { subscriptionCost } = await import('./pricing.js')
    // Две покупки, два масштаба. КЛИЕНТ выбирает СВОЙ набор — это и есть продажа
    // («зайшов і вибрав»), пока без оплаты. ВЛАДЕЛЕЦ без userId меняет общий набор
    // пространства; чужой личный — тоже только владелец: это деньги другого человека.
    const me = req.header('x-user-id')
    const admin = await isAdminRequest(req)
    if (req.body?.userId && !admin) {
      return res.status(403).json({ ok: false, error: 'Чужую подписку меняет только владелец' })
    }
    const wanted = req.body?.modules
    const list = wanted === 'all' ? 'all' : (Array.isArray(wanted) ? wanted : [])
    const target = req.body?.userId || me
    const { setUserModules } = await import('./balance.js')
    // Админ без явного userId правит ОБЩИЙ набор; всё остальное — личная покупка.
    const personal = !(admin && !req.body?.userId)
    const months = Number(req.body?.months) || 0
    const balance = personal ? await setUserModules(list, target, { months }) : await setModules(list, target, { months })
    const { subscriptionCost: subCost, periodCost } = await import('./pricing.js')
    const { effectivePrices } = await import('./priceStore.js')
    const bundlesList = await (await import('./bundles.js')).listBundles()
    const effPrices = await effectivePrices()
    const monthly = list === 'all' ? null : subCost(list, bundlesList, effPrices.monthMap)
    // paid — то, что реально заряжено за период (год со скидкой), НЕ месячная цена.
    const paid = monthly ? periodCost(monthly.sum, months || 1, effPrices.annualDiscount) : null
    await appendAudit({
      action: 'subscription.set',
      module: 'billing',
      initiator: req.header('x-user-id') || 'system',
      reason: `Подписка${(admin && !req.body?.userId) ? ' пространства' : ` (${target || 'свой'})`}: ${list === 'all' ? 'все модули' : `${list.length} модулей`}`,
      meta: { modules: list, months: months || 1, cost: monthly, paid },
    }).catch(() => {})
    res.json({ ok: true, balance })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §5.1: операции по кошельку — «за что списали». Свой журнал видит каждый,
 * чужой — только админ: это деньги конкретного человека.
 */
app.get('/api/balance/history', async (req, res) => {
  try {
    const { walletHistory } = await import('./balance.js')
    const me = req.header('x-user-id')
    const target = req.query.userId ? String(req.query.userId) : me
    if (req.query.userId && req.query.userId !== me && !(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Чужие операции доступны только администратору' })
    }
    const rows = await walletHistory({ userId: target, limit: req.query.limit ? Number(req.query.limit) : undefined })
    res.json({ ok: true, rows })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §5.1 (B2): баланс монет и тариф. Читают все — шапка показывает их на каждой странице.
// Менять (пополнение/списание/смена тарифа) — только админ: это деньги, а не настройка.
app.get('/api/balance', async (req, res) => {
  try {
    // Свой баланс у каждого пользователя: ключ — X-User-Id. Без сессии (дев)
    // отдаётся общий кошелёк, как и раньше.
    const { getBalance } = await import('./balance.js')
    res.json({ ok: true, balance: await getBalance(req.header('x-user-id')) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
app.post('/api/balance', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Менять баланс может только админ' })
    const { getBalance, changeCoins, changeUsd, setPlan } = await import('./balance.js')
    const { amount, usd, planId, reason, userId } = req.body ?? {}
    // Админ может пополнить ЧУЖОЙ кошелёк, явно указав userId — иначе правит свой.
    const target = userId || req.header('x-user-id')
    let changed = null
    // §11.4: два кошелька. `amount` — токены (как раньше), `usd` — деньги.
    if (amount !== undefined) changed = await changeCoins(amount, reason, target)
    if (usd !== undefined) changed = await changeUsd(usd, reason, target)
    if (planId !== undefined) await setPlan(planId, target)
    const balance = await getBalance(target)
    await appendAudit({
      action: 'balance.change', module: 'balance', initiator: req.header('x-user-id') || 'operator',
      reason: planId !== undefined
        ? `Тариф ${target || 'общий'}: ${balance.plan.name}`
        : `Баланс ${target || 'общий'}: ${changed?.before} → ${changed?.after}${reason ? ` (${reason})` : ''}`,
      meta: { ...changed, planId: balance.planId },
    }).catch(() => {})
    res.json({ ok: true, balance })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.4: купить токены за деньги. Свой кошелёк — сам, чужой — только админ:
 * тратить чужие деньги без прав нельзя.
 */
app.post('/api/balance/buy-tokens', async (req, res) => {
  try {
    const { usd, userId } = req.body ?? {}
    const me = req.header('x-user-id')
    const target = userId || me
    if (userId && userId !== me && !(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Покупать токены другому может только админ' })
    }
    const { buyTokens } = await import('./balance.js')
    const out = await buyTokens({ usd, userId: target })
    await appendAudit({
      action: 'tokens.buy', module: 'balance', initiator: me || 'operator',
      reason: `Куплено ${out.tokens} ⚡ за $${out.spentUsd.toFixed(2)}`,
      meta: { userId: target, usd: out.spentUsd, tokens: out.tokens, rate: out.rate },
    }).catch(() => {})
    res.json({ ok: true, ...out })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

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
