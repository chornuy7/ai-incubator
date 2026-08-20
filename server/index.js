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
import { getAllAccountBusy, reconcileBusy } from './lib/accountBusy.js'
import { buildAccountStats, listAccountChannels, listAccountChannelMessages, listAccountFolders, leaveAccountChannel } from './accountStats.js'
import { dailySummary, dailySummaryAll } from './lib/dailyActions.js'
import { rpsMiddleware, systemMetrics } from './lib/systemMetrics.js'
import { setMaxConcurrent, getConcurrencyState } from './modules/workers.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use('/api', rpsMiddleware) // §10.9: считаем RPS по всем API-запросам для мониторинга нагрузки

// Продакшн-замок: личность из подписанного токена, при SESSION_SECRET — вход обязателен.
// Монтируется ДО всех /api-роутов, чтобы RBAC ниже работал на доверенной личности.
const { sessionGuard } = await import('./lib/authGuard.js')
app.use('/api', sessionGuard)

// Отключённый профиль (active=false) не должен видеть НИЧЕГО, кроме своего состояния,
// оплаты и поддержки. RLS в Supabase это не закроет: бэкенд ходит сервисным ключом и
// RLS обходит — значит правило живёт здесь, сразу после проверки личности.
const { accessGate } = await import('./lib/accessGate.js')
app.use('/api', accessGate)

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
    // Аккаунты — имущество ПРОСТРАНСТВА. Сотрудник видит аккаунты своего владельца
    // (дальше их ещё режет роль), посторонний — только свои. Админ и дев без сессии —
    // все: у первого это работа, у второго нет пространства вовсе.
    const me = req.header('x-user-id')
    let ownerId = null
    if (me && !(await isAdminRequest(req))) {
      const { resolveSubscriptionOwner } = await import('./users.js')
      ownerId = await resolveSubscriptionOwner(me)
    }
    const accounts = await tgListAccounts({
      verify: req.query.verify === '1' || req.query.verify === 'true',
      ...(ownerId ? { ownerId } : {}),
    })
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
  // То же самое для реестра занятости ДЕЙСТВИЕМ и его выдача наружу: слот мёртвой задачи
  // выключает аккаунт из всех модулей, а оператор его до сих пор не видел — «занят» в UI
  // означало только блокировку задачей.
  try { reconcileBusy() } catch { /* ignore */ }
  res.json({ ok: true, busy: await getAllAccountLocksDetailed(), working: getAllAccountBusy() })
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
    // force=1 — живая проверка по кнопке. Без него отдаём сохранённый вердикт мгновенно.
    const force = req.query.force === '1' || req.query.force === 'true'
    const stats = await buildAccountStats(req.params.accountId, { spam, force })
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

// MR-164: последние сообщения канала/группы аккаунта — просмотр переписки из карточки.
app.get('/api/tg/accounts/:accountId/channel-messages', async (req, res) => {
  try {
    const result = await listAccountChannelMessages(req.params.accountId, String(req.query.peer || ''), Number(req.query.limit) || 30)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// MR-129: выход аккаунта из канала/группы прямо из карточки.
app.post('/api/tg/accounts/:accountId/channels/:channelId/leave', async (req, res) => {
  try {
    const r = await leaveAccountChannel(req.params.accountId, req.params.channelId)
    if (!r.ok) return res.status(400).json(r)
    res.json(r)
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
  // Многомодульность (20.08): держателей у аккаунта несколько, а `info.moduleKey` —
  // только ПЕРВЫЙ из них. У пары [мейлинг, прогрев] гейт видел мейлинг и пропускал
  // обычного оператора, после чего forceReleaseAccount сносил запись целиком — вместе с
  // прогревом, который §12 запрещает снимать не-админу. Смотрим ВСЕХ держателей.
  const holders = info?.holders?.length ? info.holders : (info ? [info] : [])
  const warming = holders.find((h) => WARMING_MODULES.has(h.moduleKey))
  if (warming && !canStopWarming(await isAdminRequest(req))) {
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

/**
 * §10.3: задан ли сервисный ключ «мозгов» в окружении. Само значение не отдаём —
 * только факт «настроен / не настроен», чтобы владелец видел статус в админке.
 */
app.get('/api/admin/api-keys/service', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступ только владельцу' })
    const { serviceKeyConfigured } = await import('./apiKeys.js')
    res.json({ ok: true, configured: serviceKeyConfigured() })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// §11.8: выпуск ключа ПОД ПОЛЬЗОВАТЕЛЯ убран — «мозги» ходят сервисным ключом из env
// (MURMEX_API_KEY), а не персональными ключами из админки. Остаются только просмотр и
// отзыв (ниже) — чтобы можно было погасить любой оставшийся легаси-ключ.

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

/**
 * LOG-003 (MR-122): история действий одного аккаунта — все посты/комменты/реакции/чаты/
 * вступления, что он совершил. Фильтры: тип действия, группа/канал, период. Ссылки на
 * объекты формируются на фронте из objectRef. Читаем из журнала действий (LOG-002).
 */
app.get('/api/accounts/:accountId/actions', async (req, res) => {
  try {
    const id = String(req.params.accountId || '')
    const { canSeeAccount } = await import('./lib/accessGuard.js')
    if (!(await canSeeAccount(req, id))) return res.status(403).json({ ok: false, error: 'Нет доступа к этому аккаунту' })
    const { readActions } = await import('./actionLog.js')
    const actions = await readActions({
      accountId: id,
      type: req.query.type ? String(req.query.type) : undefined,
      target: req.query.target ? String(req.query.target) : undefined,
      since: req.query.since ? Number(req.query.since) : undefined,
      until: req.query.until ? Number(req.query.until) : undefined,
      limit: req.query.limit ? Math.min(2000, Number(req.query.limit)) : 500,
    })
    res.json({ ok: true, actions })
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
 * §5.2 (MR-34): логи одной задачи по запросу — раскрывая ошибочную задачу в «Проблемах»,
 * оператор видит не только причину, но и журнал. Грузим лениво (не тащим логи всех задач
 * в общий ответ). Отдаём хвост журнала, ошибки первыми — по ним и разбираются.
 */
app.get('/api/admin/task-logs', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Логи доступны только администратору' })
    const moduleKey = String(req.query.module || ''), id = String(req.query.id || '')
    if (!moduleKey || !id) return res.status(400).json({ ok: false, error: 'Нужны module и id' })
    const { getModuleStore } = await import('./modules/registry.js')
    const store = getModuleStore(moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
    const task = await store.loadTask(id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    // Последние 60 записей, каждую подрезаем — журнал одной задачи может быть большим.
    const logs = (task.logs || []).slice(-60).map((l) => ({
      ts: Number(l.ts) || 0, level: String(l.level || 'info'),
      account: String(l.account || ''), message: String(l.message || '').slice(0, 500),
    }))
    res.json({ ok: true, id, moduleKey, status: task.status || '', logs })
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
    // Кто собрал набор — в audit_log ниже (initiator). Наборы глобальные, owner-колонки у них нет.
    const bundle = await createBundle(req.body || {})
    await appendAudit({
      action: 'bundle.create', module: 'billing', initiator: req.header('x-user-id') || 'system',
      reason: `Набор «${bundle.name}»: ${bundle.modules.length} модулей за ${bundle.price}`,
      meta: bundle,
    }).catch(() => {})
    resyncModuleLinks()
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
    resyncModuleLinks()
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
/**
 * §11.3: пересобрать проекцию модульных связей после изменения подписки/набора/цен.
 * После ответа и best-effort: проекция нужна для читаемости БД, а не для работы
 * биллинга, поэтому её сбой не должен ронять сохранение.
 */
function resyncModuleLinks() {
  void import('./lib/typesSync.js')
    .then((m) => m.syncModuleLinks())
    .catch((e) => console.warn('[links] пересборка связей модулей не удалась:', e?.message || e))
}

app.post('/api/admin/sync-types', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступно только администратору' })
    const { syncTypesAndModules, syncModuleLinks } = await import('./lib/typesSync.js')
    const report = await syncTypesAndModules()
    // §11.3: связи модулей (подписки/наборы/кампании/цены) — той же кнопкой.
    report.moduleLinks = await syncModuleLinks().catch((e) => ({ ok: false, reason: e?.message }))
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

/**
 * MR-134: диалоги, ждущие НАШЕГО ответа — «пропущенные ЛС». Последнее сообщение в
 * диалоге входящее (direction 'in') и висит дольше таймаута (по умолчанию 15 мин):
 * значит ИИ/оператор не ответил. Считаем по сообщениям (messages), группируя по
 * (аккаунт, собеседник). Для колокольчика — отдельным жёлтым уведомлением.
 */
app.get('/api/messages/awaiting', async (req, res) => {
  try {
    const { listMessages } = await import('./messages.js')
    const userId = req.header('x-user-id') || ''
    const rows = await listMessages({ userId: userId || undefined, limit: 2000 })
    const timeoutMs = Number(process.env.MISSED_DM_TIMEOUT_MS) || 15 * 60 * 1000
    const byDialog = new Map()
    for (const m of rows) {
      const key = `${m.accountId}|${m.peer}`
      const prev = byDialog.get(key)
      if (!prev || (m.at || 0) > (prev.at || 0)) byDialog.set(key, m)
    }
    const now = Date.now()
    const awaiting = [...byDialog.values()].filter((m) => m.direction === 'in' && (now - (m.at || 0)) > timeoutMs)
    res.json({
      ok: true,
      count: awaiting.length,
      items: awaiting.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 20)
        .map((m) => ({ accountId: m.accountId, peer: m.peer, text: (m.text || '').slice(0, 60), at: m.at })),
    })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §11.3: завести существующих пользователей в Supabase Auth (пригласительными письмами).
 *
 * Отвечает на «как юзеры попадут в БД» для тех, кто уже есть у нас: приглашение вместо
 * ручного заведения. Пароли НЕ задаются здесь — человек переходит по ссылке из письма и
 * задаёт свой. Так пароли не проходят ни через нас, ни через логи.
 *
 * Профиль создавать не нужно: его ставит триггер on_auth_user_created.
 * Идемпотентно: у кого auth-запись уже есть — пропускаем.
 */
app.post('/api/admin/provision-auth', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Доступно только администратору' })
    const { getSupabase, supabaseEnabled } = await import('./lib/supabase.js')
    if (!supabaseEnabled()) return res.status(400).json({ ok: false, error: 'Нужен DATA_BACKEND=supabase' })
    const db = getSupabase()
    if (!db) return res.status(400).json({ ok: false, error: 'Нет клиента Supabase' })

    const { data: authList, error: authErr } = await db.auth.admin.listUsers({ perPage: 1000 })
    if (authErr) return res.status(500).json({ ok: false, error: `auth.users: ${authErr.message}` })
    const have = new Set((authList?.users || []).map((u) => String(u.email || '').toLowerCase()))

    const { listUsers } = await import('./users.js')
    const users = await listUsers()
    // Можно ограничить список адресатов: письмо уйдёт только на указанные почты
    // (у остальных доступа к ящику может не быть, слать им приглашение бессмысленно
    // и жжёт лимит бесплатного мейлера).
    const only = Array.isArray(req.body?.emails) && req.body.emails.length
      ? new Set(req.body.emails.map((e) => String(e).trim().toLowerCase()))
      : null
    const invited = []; const skipped = []; const failed = []
    for (const u of users) {
      const email = String(u.email || '').trim()
      if (!email) continue
      if (only && !only.has(email.toLowerCase())) { skipped.push(email); continue }
      if (have.has(email.toLowerCase())) { skipped.push(email); continue }
      const { error } = await db.auth.admin.inviteUserByEmail(email, { data: { name: u.name || '' } })
      if (error) failed.push({ email, error: error.message }); else invited.push(email)
    }
    await appendAudit({
      action: 'auth.provision', module: 'admin', initiator: req.header('x-user-id') || 'system',
      reason: `Приглашения в Supabase Auth: ${invited.length}`, meta: { invited, skipped, failed },
    }).catch(() => {})
    res.json({ ok: true, invited, skipped, failed })
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

/** §10.9 (кол 29.07): нагрузка сервера сейчас — RPS и загрузка CPU/памяти. Только админ. */
app.get('/api/admin/system', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Мониторинг доступен только администратору' })
    res.json({ ok: true, system: systemMetrics() })
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

/** §3.3 (MR-23): экономика — доходы, расходы, маржа, разрез по серверам. Только админ. */
app.get('/api/admin/economy', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Экономика доступна только администратору' })
    const { economyReport } = await import('./adminStats.js')
    res.json({ ok: true, economy: await economyReport({
      since: req.query.since ? Number(req.query.since) : undefined,
      until: req.query.until ? Number(req.query.until) : undefined,
    }) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/**
 * §6 (MR-38): есть ли сохранённый результат парсинга под этот запрос (кэш-первым).
 * Отдаёт результат + дату обновления, чтобы витрина показала «из базы от …» без нового
 * прохода. POST — запрос описывается набором ключей/окончаний/фильтров (settings).
 */
app.post('/api/parser/cache/lookup', async (req, res) => {
  try {
    const { kind, settings } = req.body || {}
    if (!kind || !settings) return res.status(400).json({ ok: false, error: 'Нужны kind и settings' })
    const { lookupParserResults } = await import('./parserCache.js')
    res.json({ ok: true, cache: lookupParserResults(String(kind), settings) })
  } catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

// ── §8 (MR-44): тикеты поддержки — свои у клиента, все у админа (интеграция с админкой) ──
const ticketErr = (res, err) => res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })

/** Автор-клиент: id + имя + ПОЧТА. Почта — главная подпись в чате (имя бывает ролевым). */
const ticketAuthor = (ctx) => ({ id: ctx.id, name: String(ctx.user?.name || ''), email: String(ctx.user?.email || '') })

/** Резолвер владельцев тикетов id→{ownerName,ownerEmail} одним запросом — «от кого» в списке. */
async function ticketOwnerResolver() {
  try {
    const { listUsers } = await import('./users.js')
    const users = await listUsers()
    const m = new Map(users.map((u) => [String(u.id), u]))
    return (t) => { const u = m.get(String(t.userId)); return { ownerName: u?.name || '', ownerEmail: u?.email || '' } }
  } catch { return () => ({ ownerName: '', ownerEmail: '' }) }
}

/**
 * Сторона запроса: 'support' (видит все тикеты, отвечает как поддержка) или 'user' (владелец).
 * Поддержкой считаем ТОЛЬКО когда фронт явно просит (?scope=all / ?as=support / asSupport:true)
 * И у автора есть право. Иначе — владелец: так админ на своей странице /panel/support пишет
 * от своего имени как обычный клиент, а «Поддержкой» отвечает из Админ-панели → «Тикеты».
 */
function ticketSide(req, ctx) {
  const wantSupport = String(req.query.scope || '') === 'all'
    || String(req.query.as || '') === 'support'
    || (req.body && req.body.asSupport === true)
  return wantSupport && ctx.isSupport ? 'support' : 'user'
}

/** Список тикетов: ?scope=all — все (только поддержка), иначе свои. С «от кого» и непрочитанным. */
app.get('/api/tickets', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { listTickets, unreadFor } = await import('./tickets.js')
    const side = ticketSide(req, ctx)
    const rows = await listTickets({ userId: ctx.id, all: side === 'support' })
    const owner = await ticketOwnerResolver()
    res.json({ ok: true, tickets: rows.map((t) => ({ ...t, ...owner(t), unread: unreadFor(t, side) })) })
  } catch (err) { ticketErr(res, err) }
})

/** Суммарно непрочитанных для стороны запроса — для красного значка в навигации. */
app.get('/api/tickets/unread-count', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.json({ ok: true, count: 0 })
    const { listTickets, unreadFor } = await import('./tickets.js')
    const side = ticketSide(req, ctx)
    const rows = await listTickets({ userId: ctx.id, all: side === 'support' })
    res.json({ ok: true, count: rows.reduce((n, t) => n + unreadFor(t, side), 0), side })
  } catch (err) { ticketErr(res, err) }
})

/** Создать тикет — владелец всегда автор запроса (клиент не может создать за другого). */
app.post('/api/tickets', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { createTicket } = await import('./tickets.js')
    const { subject, category, body } = req.body || {}
    res.json({ ok: true, ticket: await createTicket({ userId: ctx.id, author: ticketAuthor(ctx), subject, category, body }) })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** Один тикет с перепиской — владелец или поддержка. Открытие отмечает прочитанным для стороны. */
app.get('/api/tickets/:id', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { getTicket, markRead, unreadFor } = await import('./tickets.js')
    const t = await getTicket(String(req.params.id))
    if (!t) return res.status(404).json({ ok: false, error: 'Тикет не найден' })
    if (!ctx.isSupport && t.userId !== ctx.id) return res.status(403).json({ ok: false, error: 'Нет доступа к тикету' })
    const side = ticketSide(req, ctx)
    const fresh = (await markRead(String(req.params.id), side)) || t
    const owner = await ticketOwnerResolver()
    res.json({ ok: true, ticket: { ...fresh, ...owner(fresh), unread: unreadFor(fresh, side) } })
  } catch (err) { ticketErr(res, err) }
})

/** Ответ: поддержка (asSupport) пишет как «Поддержка», клиент — от своего имени (только в свой тикет). */
app.post('/api/tickets/:id/reply', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { getTicket, addMessage } = await import('./tickets.js')
    const t = await getTicket(String(req.params.id))
    if (!t) return res.status(404).json({ ok: false, error: 'Тикет не найден' })
    const asSupport = (req.body || {}).asSupport === true && ctx.isSupport
    if (!asSupport && t.userId !== ctx.id) return res.status(403).json({ ok: false, error: 'Нет доступа к тикету' })
    const ticket = await addMessage(String(req.params.id), {
      from: asSupport ? 'support' : 'user',
      // Поддержка подписывается ролью (клиенту не нужен личный контакт оператора),
      // клиент — своей почтой/именем.
      author: asSupport ? { id: ctx.id, name: 'Поддержка' } : ticketAuthor(ctx),
      text: (req.body || {}).text,
    })
    res.json({ ok: true, ticket })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})

/** Отметить тикет прочитанным для стороны запроса (?as=support для поддержки). */
app.post('/api/tickets/:id/read', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { getTicket, markRead } = await import('./tickets.js')
    const t = await getTicket(String(req.params.id))
    if (!t) return res.status(404).json({ ok: false, error: 'Тикет не найден' })
    if (!ctx.isSupport && t.userId !== ctx.id) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    await markRead(String(req.params.id), ticketSide(req, ctx))
    res.json({ ok: true })
  } catch (err) { ticketErr(res, err) }
})

/** Сменить статус тикета — поддержка (роль «Поддержка») или админ. */
app.post('/api/tickets/:id/status', async (req, res) => {
  try {
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (!ctx.isSupport) return res.status(403).json({ ok: false, error: 'Статусы меняет только поддержка' })
    const { setStatus } = await import('./tickets.js')
    res.json({ ok: true, ticket: await setStatus(String(req.params.id), String((req.body || {}).status)) })
  } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
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
    const { CURRENCY, maxTextTokens, fullActionPrice } = await import('./pricing.js')
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
    // MR-149: ЕДИНАЯ цена действия = фикс-действие + текст «по максимуму символов»
    // (по курсу coinsPer1kTokens). Витрина показывает эту цену, за токены сверх не списываем.
    const maxTokensMap = {}
    const actionsFull = {}
    for (const key of Object.keys(eff.actionMap)) {
      maxTokensMap[key] = maxTextTokens(key)
      // База «за действие» — из админки (eff.actionMap), текст код добавляет сам.
      actionsFull[key] = fullActionPrice(key, eff.coinsPer1kTokens, eff.actionMap[key])
    }
    const items = eff.modules
      .filter((m) => m.action > 0)
      .map((m) => ({ key: m.key, title: m.title, price: m.action, avgTokens: avgTokens[m.key] || 0 }))
      .sort((a, b) => b.price - a.price || a.title.localeCompare(b.title, 'ru'))
    res.json({
      ok: true, items, actions: eff.actionMap, actionsFull, maxTextTokens: maxTokensMap, avgTokens,
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
      .map((m) => ({ key: m.key, title: m.title, price: m.month, gift: m.gift || 0, action: m.action || 0 })) // §3: подарочные токены (MR-21) + цена действия (MR-22)
      .sort((a, b) => b.price - a.price || a.title.localeCompare(b.title, 'ru'))
    const setups = [
      ...SETUPS.map((s) => ({ ...s, cost: subscriptionCost(s.modules, bundles, priceMap, eff.giftMap) })),
      ...bundles.map((b) => {
        const cost = subscriptionCost(b.modules, bundles, priceMap, eff.giftMap)
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
    res.json({ ok: true, ...subscriptionCost(req.body?.modules || [], await listBundles(), eff.monthMap, eff.giftMap) })
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
    // Подписку оформляет ВЛАДЕЛЕЦ пространства. Суб платить не может: деньги общие,
    // а набор модулей всё равно читается у владельца (MR-28) — его покупка просто
    // сожгла бы средства впустую (правка 18.08).
    if (me && !req.body?.userId) {
      const { getUser } = await import('./users.js')
      const meUser = await getUser(me).catch(() => null)
      if (meUser?.parentId) {
        return res.status(403).json({ ok: false, error: 'Подписку оформляет владелец пространства' })
      }
    }
    const wanted = req.body?.modules
    const list = wanted === 'all' ? 'all' : (Array.isArray(wanted) ? wanted : [])
    const target = req.body?.userId || me
    const { setUserModules } = await import('./balance.js')
    // Админ без явного userId правит ОБЩИЙ набор; всё остальное — личная покупка.
    const personal = !(admin && !req.body?.userId)
    const months = Number(req.body?.months) || 0
    const { subscriptionCost: subCost, periodCost } = await import('./pricing.js')
    const { effectivePrices } = await import('./priceStore.js')
    const bundlesList = await (await import('./bundles.js')).listBundles()
    const effPrices = await effectivePrices()
    const monthly = list === 'all' ? null : subCost(list, bundlesList, effPrices.monthMap)
    // paid — то, что реально заряжено за период (год со скидкой), НЕ месячная цена.
    const paid = monthly ? periodCost(monthly.sum, months || 1, effPrices.annualDiscount) : null

    // §11.4 (правка 18.08): подписка ОПЛАЧИВАЕТСЯ. До этого набор применялся сразу и
    // денег не спрашивал — с нулём на счету можно было открыть себе что угодно.
    //
    // Считаем только ДОБАВЛЕННЫЕ модули: смена набора и отключение лишнего не должны
    // списывать повторно за то, что уже оплачено. Админ, раздающий доступ, не платит —
    // это провижининг, а не покупка.
    const { getBalance, changeUsd } = await import('./balance.js')
    let charged = 0
    if (personal && !admin && Array.isArray(list)) {
      const before = await getBalance(target)
      const { addedCost } = await import('./pricing.js')
      const { added, monthly: addMonthly } = addedCost(before.modules, list, bundlesList, effPrices.monthMap)
      if (added.length) {
        charged = periodCost(addMonthly, months || 1, effPrices.annualDiscount)
        if ((Number(before.usd) || 0) + 1e-9 < charged) {
          return res.status(402).json({
            ok: false,
            error: `Недостаточно средств: нужно $${charged.toFixed(2)}, на счету $${(Number(before.usd) || 0).toFixed(2)}. Пополните баланс.`,
          })
        }
        await changeUsd(-charged, `Подписка: ${added.length} модул. на ${months || 1} мес.`, target)
      }
    }
    // Баг 19.08 (§2): покупка модуля ЗАТИРАЛА набор. Клиент присылал полный список,
    // и «Готовый набор» в кабинете выкидывал из него ранее оплаченное — деньги списаны,
    // доступ пропал. Клиентская покупка теперь ДОКУПКА (merge): сервер сам объединяет
    // с тем, что уже оплачено, и полному списку от клиента больше не доверяет.
    // Админ — наоборот, ЗАМЕНЯЕТ набор целиком: он выдаёт доступы явно, и снять
    // лишнее должно быть можно (это провижининг, а не продажа).
    const mode = admin ? 'replace' : 'merge'
    const balance = personal
      ? await setUserModules(list, target, { months, mode })
      : await setModules(list, target, { months, mode })
    await appendAudit({
      action: 'subscription.set',
      module: 'billing',
      initiator: req.header('x-user-id') || 'system',
      reason: `Подписка${(admin && !req.body?.userId) ? ' пространства' : ` (${target || 'свой'})`}: ${list === 'all' ? 'все модули' : `${list.length} модулей`}`,
      meta: { modules: list, months: months || 1, cost: monthly, paid, charged },
    }).catch(() => {})
    resyncModuleLinks() // §11.3: подписка изменилась — обновить проекцию связей
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
// MR-144: текущее состояние параллельности для дашборда — сколько работает, сколько ждёт, лимит.
app.get('/api/tasks/concurrency', (_req, res) => {
  try { res.json({ ok: true, ...getConcurrencyState() }) }
  catch (err) { res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' }) }
})
app.put('/api/settings', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: 'Менять настройки безопасности может только админ' })
    const settings = await updateSettings(req.body ?? {})
    // MR-144: лимит параллельных задач применяем к живому пулу воркеров сразу.
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'maxParallelTasks')) setMaxConcurrent(settings.maxParallelTasks)
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
    const wantLimit = limit ? Number(limit) : 300
    // §7 (MR-41): в user-панели человек видит СВОИ логи + логи своих субпользователей
    // (сотрудников), а не всё рабочее пространство. Админ/дев — все записи, как раньше.
    const { requesterContext } = await import('./lib/accessGuard.js')
    const ctx = await requesterContext(req)
    if (ctx.noSession || ctx.isAdmin || !ctx.user) {
      const entries = await readAudit({ limit: wantLimit, action, initiator, account })
      return res.json({ ok: true, entries })
    }
    const { listSubs } = await import('./users.js')
    const subs = await listSubs(ctx.id)
    const allowed = new Set()
    for (const u of [ctx.user, ...subs]) {
      if (u.id) allowed.add(String(u.id).toLowerCase())
      if (u.email) allowed.add(String(u.email).toLowerCase())
    }
    // Читаем шире (без initiator-фильтра) и оставляем только свои/субовские записи.
    const pool = await readAudit({ limit: 10000, action, account })
    const entries = pool.filter((e) => allowed.has(String(e.initiator || '').toLowerCase())).slice(0, wantLimit)
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

// MR-144: применить сохранённый лимит параллельных задач при старте (иначе до первой
// правки настроек действовал бы только env-дефолт).
try { setMaxConcurrent((await getSettings()).maxParallelTasks) } catch { /* дефолт остаётся */ }

const { flipped, cleared } = await reconcileStaleTasksOnBoot()
if (flipped.length) {
  console.log(`Reconcile: ${flipped.length} задач прервано рестартом — помечены на восстановление`)
}

// Деплой не должен убивать работу пользователей: задачи, прерванные перезапуском,
// поднимаются сами и продолжают с места остановки. Запуск идёт через тот же
// `resumeModuleTask`, что и кнопка «Возобновить», поэтому действуют все проверки,
// а лимит параллельности ставит лишние задачи в очередь вместо залпа по Telegram.
try {
  const { resumeMarkedTasks } = await import('./lib/taskRecovery.js')
  const { resumed, skipped } = await resumeMarkedTasks()
  if (resumed.length) console.log(`Восстановлено после перезапуска: ${resumed.length} задач`)
  if (skipped.length) console.log(`Не восстановлено: ${skipped.length} (причины — в логах задач)`)
} catch (err) {
  console.error('Восстановление задач не выполнено:', err instanceof Error ? err.message : err)
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
  // БЕЗ await — по той же причине, что и проверка прокси ниже: пересчёт trust идёт по
  // ВСЕМ аккаунтам и на файловом сторе занимает больше 20 секунд. С `await` он стоял
  // ПЕРЕД app.listen: API не слушал порт, фронт получал ECONNREFUSED на каждый запрос,
  // а в логе было тихо — снаружи это выглядело как «бэкенд не запустился» (20.08).
  void runTrust()
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

/**
 * Корректное завершение по сигналу деплоя.
 *
 * systemd при рестарте шлёт SIGTERM и ждёт. Раньше мы просто умирали посреди действия:
 * задача оставалась в статусе «выполняется», а на старте её помечали остановленной —
 * то есть каждая выкатка обрывала работу всем пользователям. Теперь активные задачи
 * помечаются как прерванные рестартом и просят воркеры выйти по паузе, дописав текущее
 * действие. На старте они поднимаются сами.
 *
 * Тайм-аут нужен обязательно: если воркер завис на сетевом вызове, systemd через свой
 * TimeoutStopSec убьёт процесс жёстко, и пометки не окажется на диске. Лучше выйти
 * самим, сохранив то, что успели.
 */
let shuttingDown = false
const GRACEFUL_EXIT_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 15_000

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal}: помечаем активные задачи на восстановление…`)

  const hardExit = setTimeout(() => {
    console.warn('[shutdown] не уложились в отведённое время — выходим принудительно')
    process.exit(0)
  }, GRACEFUL_EXIT_MS)
  hardExit.unref?.()

  try {
    const { markRunningTasksForResume } = await import('./lib/taskRecovery.js')
    const marked = await markRunningTasksForResume()
    console.log(`[shutdown] помечено задач: ${marked.length} — продолжатся после старта`)
  } catch (err) {
    console.error('[shutdown] пометить задачи не удалось:', err instanceof Error ? err.message : err)
  }

  clearTimeout(hardExit)
  // Новые соединения не принимаем; активные HTTP-запросы короткие и завершатся сами.
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref?.()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
