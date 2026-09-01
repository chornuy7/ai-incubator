import { Router } from 'express'
import { getModuleStore, listModuleKeys, validateSettings, startModuleTask, stopModuleTask, pauseModuleTask, resumeModuleTask } from './registry.js'
import { releaseTaskLocks } from '../lib/accountLocks.js'
import { assertAccountsAssignable, checkAccountsAssignable, loadAllMeta } from '../accountsMeta.js'

import { assertNoHotLeadConflict, assertActiveDialogLimit } from '../leads.js'
import { findDuplicateActiveTask } from '../lib/taskDedup.js'
import { getGoal, isGoalExpired } from '../goals.js'
import { WARMING_MODULES, canStopWarming } from '../lib/safetyLimits.js'
import { splitAudience } from '../lib/mailingAudience.js'
import { canEditTask, pickEditableSettings } from '../lib/taskEdit.js'
import { isAdminRequest, tasksForRequest, canTouchTask, ownedForRequest, ownerScopeForRequest, requesterContext } from '../lib/accessGuard.js'

export const modulesRouter = Router()

/**
 * Отсеять аккаунты, которые модуль взять не может, — или объяснить, кто мешает.
 *
 * Один аккаунт в карантине валил весь запуск, и человек шёл искать виноватого руками.
 * Теперь ответ 409 несёт состав: фронт показывает список и предлагает исключить.
 * С `skipUnavailable` сервер убирает их сам — но только если кто-то остаётся.
 * @returns {Promise<{ ok:true, accountIds:string[] } | { ok:false, payload:object }>}
 */
async function resolveUsableAccounts(settings, moduleKey, skipUnavailable) {
  const { error, blocked, usable } = await checkAccountsAssignable(settings.accountIds, moduleKey)
  if (!error) return { ok: true, accountIds: settings.accountIds }
  if (skipUnavailable && usable.length) return { ok: true, accountIds: usable }
  return {
    ok: false,
    payload: {
      ok: false,
      error: usable.length
        ? `${error} Можно исключить их и запустить на оставшихся (${usable.length}).`
        : `${error} Свободных профилей не осталось — дождитесь выхода из карантина или выберите другие.`,
      // Состав нужен фронту, чтобы показать понятный вопрос вместо голой ошибки.
      blocked,
      usableCount: usable.length,
      canSkip: usable.length > 0,
    },
  }
}

/**
 * §12: стоп/пауза прогрева — только супер-админ. Раньше это проверял ТОЛЬКО фронт
 * (TasksPage), т.е. прямой POST в обход UI убивал недели прогрева.
 * @returns {Promise<string|null>} текст ошибки или null, если можно
 */
async function warmingStopBlockReason(req, moduleKey) {
  if (!WARMING_MODULES.has(moduleKey)) return null
  if (canStopWarming(await isAdminRequest(req))) return null
  return 'Останавливать и ставить на паузу прогрев может только супер-админ: это недели работы аккаунтов, откатить нельзя.'
}


/**
 * Хватает ли монет, чтобы (пере)запустить задачу модуля. Тот же гейт, что при
 * создании: без него «Продолжить» на нулевом балансе стартовал бы задачу, которая
 * встаёт на паузу после первого же действия — человек жмёт кнопку, ничего не
 * происходит, причина видна только в логах.
 * @returns {Promise<object|null>} тело отказа или null
 */
/**
 * Оплачен ли модуль. Заказчик (23.07): набор модулей клиент собирает сам и платит
 * только за них — значит запуск надо проверять не только по балансу и роли, но и
 * по тому, что куплено. Три независимые оси: роль (что разрешил админ), подписка
 * (что оплачено), монеты (есть ли чем платить за действия).
 * @returns {Promise<object|null>} тело отказа или null
 */
/** Роль «без оплаты» (тест/модератор): доступ к модулям даёт роль, а не подписка. */
async function userHasFreeAccess(userId) {
  if (!userId) return false
  try {
    const { getUser } = await import('../users.js')
    const { rolesForUser } = await import('../roles.js')
    const user = await getUser(userId)
    if (!user) return false
    const roles = await rolesForUser(user)
    return roles.some((r) => !!r?.permissions?.freeAccess)
  } catch { return false }
}

/** «3 дня» / «1 день» / «5 дней» — для текста об истёкшей подписке. */
function daysWord(n) {
  const m10 = n % 10; const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'день'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня'
  return 'дней'
}

async function notInPlanPayload(req, moduleKey) {
  const userId = req.header('x-user-id')
  // Роль без оплаты обходит подписку — но не роль и не монеты (это отдельные оси).
  if (await userHasFreeAccess(userId)) return null
  const { getBalance, modulesAllow, subscriptionExpired, daysSinceExpiry } = await import('../balance.js')
  const { modules, expiresAt } = await getBalance(userId)
  // Баг 19.08 (§2): срок подписки ДОЛЖЕН закрывать доступ — до этого он только хранился.
  // Без сессии (дев, фоновые вызовы воркеров под кошельком `__default`) срок не
  // применяем: там набор общий и «купленный на месяц» воркспейс однажды остановил бы
  // фон целиком. `expiresAt = null` — бессрочно, тоже не закрываем.
  const expiry = userId ? (expiresAt ?? null) : null
  if (modulesAllow(modules, moduleKey, expiry)) return null
  const { moduleTitle } = await import('../lib/moduleTitles.js')
  const title = moduleTitle(moduleKey)
  // Два РАЗНЫХ отказа. «Не оплачен» — модуля нет в наборе, его надо добавить.
  // «Истекла» — модуль куплен, но срок вышел: человеку надо продлить, а не выбирать
  // заново. Одинаковый текст отправлял бы клиента не туда, поэтому отдаём и флаг
  // `expired` с датой — интерфейс может показать продление, а не витрину.
  if (subscriptionExpired(expiry) && modulesAllow(modules, moduleKey)) {
    const days = daysSinceExpiry(expiry)
    const when = days > 0 ? `${days} ${daysWord(days)} назад` : 'сегодня'
    return {
      ok: false,
      error: `Подписка истекла ${when} — модуль «${title}» приостановлен. Продлите подписку в разделе «Мои модули».`,
      needSubscription: true,
      expired: true,
      expiresAt: expiry,
      moduleKey,
    }
  }
  return {
    ok: false,
    error: `Модуль «${title}» не оплачен. Добавьте его в подписку в разделе «Мои модули».`,
    needSubscription: true,
    expired: false,
    moduleKey,
  }
}

async function noCoinsPayload(req, moduleKey) {
  const { actionPrice } = await import('../pricing.js')
  if (actionPrice(moduleKey) <= 0) return null
  const { getBalance } = await import('../balance.js')
  const { coins } = await getBalance(req.header('x-user-id'))
  if (coins > 0) return null
  return {
    ok: false,
    error: 'Закончились монеты — модули остановлены. Пополните баланс, чтобы продолжить.',
    needTopUp: true,
  }
}

/**
 * Своя ли это задача. Скрытие чужих в списке без этой проверки было бы косметикой:
 * id виден в интерфейсе, и остановить чужой запуск можно было бы прямым запросом.
 * @returns {Promise<string|null>} текст отказа или null
 */
async function foreignTaskReason(req, moduleKey, id) {
  const store = getModuleStore(moduleKey)
  if (!store) return null // модуль не найден — пусть отвечает сам обработчик
  const task = await store.loadTask(id).catch(() => null)
  if (!task) return null // нет задачи — тоже забота обработчика (404)
  if (await canTouchTask(req, task)) return null
  return 'Задача не найдена'
}

modulesRouter.get('/', (_req, res) => {
  res.json({ ok: true, modules: listModuleKeys() })
})

// Агрегат всех задач по всем модулям (дашборд «Задачи», §3.9). До /:moduleKey/tasks.
modulesRouter.get('/tasks', async (req, res) => {
  try {
    const { listModuleKeys, getModuleStore } = await import('./registry.js')
    const all = []
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      try {
        const tasks = await store.listTasks()
        for (const t of tasks) all.push({ ...t, moduleKey: key })
      } catch { /* skip module */ }
    }
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    // Каждому — его запуски; весь дашборд видит админ и роль с правом allTasks.
    res.json({ ok: true, tasks: await tasksForRequest(req, all) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.get('/:moduleKey/tasks', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const tasks = await store.listTasks()
    res.json({ ok: true, tasks: await tasksForRequest(req, tasks) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.get('/:moduleKey/tasks/:id', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const task = await store.loadTask(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    // Чужая задача = «не найдена»: подтверждать существование чужого запуска незачем.
    if (!(await canTouchTask(req, task))) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    // Расход ИИ именно этой задачи: «во сколько обошёлся запуск» — первый вопрос
    // при разборе счёта, а из общего баланса он не отвечается.
    const { tokenSummary } = await import('../tokenLedger.js')
    const tokens = await tokenSummary({ taskId: task.id }).catch(() => null)
    // §10.1: помимо числа токенов отдаём и МОНЕТЫ за них. Раньше «Потрачено» на карточке
    // показывало только spentCoins (действия), а монеты за токены ИИ recordTokens списывал
    // отдельно и в сумму не попадали — цена запуска выходила заниженной.
    res.json({ ok: true, task: { ...store.taskToDto(task), tokens: tokens?.tokens || 0, tokenCalls: tokens?.calls || 0, tokenCoins: tokens?.coins || 0 } })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

/**
 * §9.11: аудитория задачи — кому написали, кого пропустили, до кого не дошли.
 *
 * Считается на сервере: список целей бывает в тысячи строк, и гонять его в браузер
 * ради арифметики незачем. Главный потребитель — кнопка «взять оставшихся
 * в новую рассылку», ради которой человек иначе сверял бы списки руками.
 */
modulesRouter.get('/:moduleKey/tasks/:id/audience', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const task = await store.loadTask(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    // Аудитория — это список людей, кому писали. Чужую не отдаём.
    if (!(await canTouchTask(req, task))) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const targets = task.settings?.targets || task.settings?.numbers || []
    // Аккаунты задачи нужны, чтобы восстановить, кем писали, там где в истории
    // сохранилось только имя, — без id переписку не открыть.
    const meta = await loadAllMeta().catch(() => ({}))
    const accounts = (task.settings?.accountIds || []).map((id) => ({ id, name: meta[id]?.name || '' }))
    res.json({ ok: true, audience: splitAudience(targets, task.history || [], { accounts }), total: targets.length })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.post('/:moduleKey/tasks', async (req, res) => {
  try {
    const { moduleKey } = req.params
    const settings = req.body?.settings ?? req.body
    const err = validateSettings(moduleKey, settings)
    if (err) return res.status(400).json({ ok: false, error: err })

    // §6: обход порога trust — только для админа. Флаг приходит от клиента, поэтому
    // проверяем на сервере: иначе любой мог бы дописать его в запрос руками.
    if (settings.allowLowTrust === true && !(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Запускать аккаунты ниже порога trust может только админ' })
    }

    // §5.1: платный модуль на нуле не запускаем. Платные — все, у кого в прайсе
    // ненулевая цена действия: бесплатных модулей в системе не осталось, иначе
    // половиной платформы можно было пользоваться, не платя вообще. Проверяем ДО
    // создания задачи: узнать о нуле из логов уже запущенной рассылки — худший
    // из возможных способов.
    // Считаем баланс ТОГО, кто запускает: кошельки у пользователей разные,
    // и запуск на чужие монеты был бы дырой в биллинге.
    const noCoins = await noCoinsPayload(req, moduleKey)
    if (noCoins) return res.status(402).json(noCoins)
    // Тариф может быть поштучным — модуль должен быть в него включён.
    const notInPlan = await notInPlanPayload(req, moduleKey)
    if (notInPlan) return res.status(402).json(notInPlan)

    // Guard безопасного назначения (§3.2/§3.3): не отдаём непрогретые/занятые статусом профили.
    // Недоступные можно исключить — тогда задача идёт на оставшихся, а не падает целиком.
    const picked = await resolveUsableAccounts(settings, moduleKey, req.body?.skipUnavailable === true)
    if (!picked.ok) return res.status(409).json(picked.payload)
    settings.accountIds = picked.accountIds
    // Guard «горячий лид» (§3.3/§4): не забираем аккаунт из активного диалога в другой модуль.
    const hotErr = await assertNoHotLeadConflict(settings.accountIds, moduleKey)
    if (hotErr) return res.status(409).json({ ok: false, error: hotErr })
    // Guard лимита активных диалогов (§3.6): не перегружаем профиль (если задан maxActiveDialogs).
    const dlgErr = await assertActiveDialogLimit(settings.accountIds, moduleKey, settings.maxActiveDialogs)
    if (dlgErr) return res.status(409).json({ ok: false, error: dlgErr })
    // §4: цель с истёкшим дедлайном «останавливает работу» — не даём запускать под неё новые задачи.
    if (settings.goalId) {
      const goal = await getGoal(settings.goalId).catch(() => null)
      if (goal && isGoalExpired(goal)) {
        return res.status(409).json({ ok: false, error: `Цель «${goal.name}» просрочена (дедлайн ${goal.deadline}) — работа по ней остановлена. Продлите дедлайн или уберите цель.`, goalExpired: true })
      }
    }
    // §7: проверка уникальности — не запускаем вторую идентичную активную задачу
    // (те же аккаунты + цель + цели/каналы), чтобы не дублировать работу.
    if (!req.body?.allowDuplicate) {
      const existingStore = getModuleStore(moduleKey)
      const dup = existingStore ? findDuplicateActiveTask(await existingStore.listTasks(), settings) : null
      if (dup) return res.status(409).json({ ok: false, error: `Идентичная задача уже ${dup.status === 'paused' ? 'на паузе' : 'запущена'} (#${dup.id}). Дождитесь завершения или остановите её — иначе задублируете работу.`, duplicateTaskId: dup.id })
    }

    const { store, task, worker } = startModuleTask(moduleKey, settings)
    task.initiator = settings.initiator || 'operator' // §3.9: кто запустил
    task.goalId = settings.goalId ?? null // §3.6: к какой цели
    task.campaignId = settings.campaignId ?? null // §0: под какой кампанией
    // Чей кошелёк платит за ИИ этой задачи. Кошельки пер-юзерные, а списание идёт
    // из воркера в фоне — если не запомнить владельца при запуске, потом уже негде взять.
    task.userId = req.header('x-user-id') || ''
    try {
      await store.saveTask(task)
      const { startWorker } = await import('./workers.js')
      startWorker(task.id, store, worker)
      const { appendAudit } = await import('../lib/auditLog.js')
      await appendAudit({
        action: 'task.start',
        module: moduleKey,
        initiator: task.initiator,
        scope: { taskId: task.id, accounts: settings.accountIds || [] },
        reason: `Запуск задачи ${moduleKey}`,
      }).catch(() => {})
      // §4.4 (D4): анти-кластерные предупреждения отдаём вместе с задачей — они
      // НЕ запрещают запуск (решение за оператором), но он должен увидеть риск
      // сразу, а не после того, как Telegram забанит группу волной.
      let clusterWarnings = []
      try {
        const { clusterWarnings: warn } = await import('../lib/antiCluster.js')
        const all = await loadAllMeta()
        const proxyByAccount = {}
        for (const id of settings.accountIds || []) proxyByAccount[id] = all[id]?.proxy || ''
        clusterWarnings = warn({
          proxyByAccount,
          accountIds: settings.accountIds || [],
          targets: settings.channels || settings.targets || [],
        })
      } catch { /* предупреждения не должны мешать запуску */ }
      res.json({ ok: true, task: store.taskToDto(task), clusterWarnings })
    } catch (err) {
      releaseTaskLocks(task.id)
      throw err
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.post('/:moduleKey/tasks/:id/stop', async (req, res) => {
  try {
    const foreign = await foreignTaskReason(req, req.params.moduleKey, req.params.id)
    if (foreign) return res.status(404).json({ ok: false, error: foreign })
    const blocked = await warmingStopBlockReason(req, req.params.moduleKey)
    if (blocked) return res.status(403).json({ ok: false, error: blocked })
    const task = await stopModuleTask(req.params.moduleKey, req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const { appendAudit } = await import('../lib/auditLog.js')
    await appendAudit({
      action: 'task.stop',
      module: req.params.moduleKey,
      initiator: req.body?.initiator || 'operator',
      scope: { taskId: req.params.id },
      reason: 'Остановка задачи',
    }).catch(() => {})
    const store = getModuleStore(req.params.moduleKey)
    res.json({ ok: true, task: store.taskToDto(task) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// Пауза задачи (§3.9): воркер выходит, статус «paused», прогресс сохранён.
/**
 * §9.8: правка настроек задачи. Разрешена ТОЛЬКО на паузе (решение 21.07) —
 * см. пояснение в `lib/taskEdit.js`. Смена аккаунтов не поддерживается: за задачей
 * держатся локи, подмена состава оставила бы их висеть на чужих аккаунтах.
 */
modulesRouter.patch('/:moduleKey/tasks/:id/settings', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const task = await store.loadTask(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    if (!(await canTouchTask(req, task))) return res.status(404).json({ ok: false, error: 'Задача не найдена' })

    const gate = canEditTask(task.status)
    if (!gate.ok) return res.status(409).json({ ok: false, error: gate.reason, status: task.status })

    const { settings, rejected } = pickEditableSettings(req.body?.settings)
    if (!Object.keys(settings).length) {
      return res.status(400).json({ ok: false, error: 'Нечего менять: не передано ни одного изменяемого поля', rejected })
    }

    // Смена состава исполнителей (звонок 12.08). Локи переоформляем: снимаем все за этой
    // задачей и берём заново на новый состав. Иначе выбывшие аккаунты остались бы
    // «занятыми» этой задачей, а добавленные работали бы без защиты от второй.
    if (Array.isArray(settings.accountIds)) {
      const next = settings.accountIds.filter(Boolean)
      if (!next.length) return res.status(400).json({ ok: false, error: 'Оставьте хотя бы один аккаунт' })
      const { releaseTaskLocks, tryAcquireLocks } = await import('../lib/accountLocks.js')
      const prev = task.settings?.accountIds || []
      const changed = next.length !== prev.length || next.some((id) => !prev.includes(id))
      if (changed) {
        // Пауза держит локи; у остановленной их уже нет — releaseTaskLocks в обоих случаях безопасен.
        releaseTaskLocks(task.id)
        // Локи берём заново ТОЛЬКО для задачи, которую ещё продолжат (пауза). Завершённая
        // задача исполнителей не держит — состав просто сохраняем к перезапуску.
        if (task.status === 'paused') {
          const lockErr = tryAcquireLocks(next, req.params.moduleKey, task.id, { goalId: task.settings?.goalId })
          if (lockErr) {
            // Не смогли занять новых — возвращаем прежний состав, чтобы задача не осталась ни с чем.
            tryAcquireLocks(prev, req.params.moduleKey, task.id, { goalId: task.settings?.goalId })
            return res.status(409).json({ ok: false, error: lockErr })
          }
        }
      }
    }

    task.settings = { ...task.settings, ...settings }
    await store.saveTask(task)

    const { appendAudit } = await import('../lib/auditLog.js')
    await appendAudit({
      action: 'task.edit',
      module: req.params.moduleKey,
      initiator: req.body?.initiator || 'operator',
      scope: { taskId: req.params.id },
      reason: `Правка задачи (${task.status}): ${Object.keys(settings).join(', ')}`,
      meta: { fields: Object.keys(settings) },
    }).catch(() => {})

    res.json({ ok: true, task: store.taskToDto(task), rejected })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.post('/:moduleKey/tasks/:id/pause', async (req, res) => {
  try {
    const foreign = await foreignTaskReason(req, req.params.moduleKey, req.params.id)
    if (foreign) return res.status(404).json({ ok: false, error: foreign })
    const blocked = await warmingStopBlockReason(req, req.params.moduleKey)
    if (blocked) return res.status(403).json({ ok: false, error: blocked })
    const task = await pauseModuleTask(req.params.moduleKey, req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const { appendAudit } = await import('../lib/auditLog.js')
    await appendAudit({ action: 'task.pause', module: req.params.moduleKey, initiator: req.body?.initiator || 'operator', scope: { taskId: req.params.id }, reason: 'Пауза задачи' }).catch(() => {})
    res.json({ ok: true, task: getModuleStore(req.params.moduleKey).taskToDto(task) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// Продолжить приостановленную задачу (§3.9): перезахват локов + запуск с сохранённым прогрессом.
modulesRouter.post('/:moduleKey/tasks/:id/resume', async (req, res) => {
  try {
    const foreign = await foreignTaskReason(req, req.params.moduleKey, req.params.id)
    if (foreign) return res.status(404).json({ ok: false, error: foreign })
    const noCoins = await noCoinsPayload(req, req.params.moduleKey)
    if (noCoins) return res.status(402).json(noCoins)
    // И подписку тоже: иначе задачу отключённого модуля можно было продолжать.
    const notInPlan = await notInPlanPayload(req, req.params.moduleKey)
    if (notInPlan) return res.status(402).json(notInPlan)
    const task = await resumeModuleTask(req.params.moduleKey, req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const { appendAudit } = await import('../lib/auditLog.js')
    await appendAudit({ action: 'task.resume', module: req.params.moduleKey, initiator: req.body?.initiator || 'operator', scope: { taskId: req.params.id }, reason: 'Продолжение задачи' }).catch(() => {})
    res.json({ ok: true, task: getModuleStore(req.params.moduleKey).taskToDto(task) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// Перезапуск задачи с её же настройками (§3.9 трекер: restart). Создаёт НОВУЮ задачу.
modulesRouter.post('/:moduleKey/tasks/:id/restart', async (req, res) => {
  try {
    const { moduleKey, id } = req.params
    const store = getModuleStore(moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const old = await store.loadTask(id)
    if (!old) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    if (!(await canTouchTask(req, old))) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const noCoins = await noCoinsPayload(req, moduleKey)
    if (noCoins) return res.status(402).json(noCoins)
    const notInPlan = await notInPlanPayload(req, moduleKey)
    if (notInPlan) return res.status(402).json(notInPlan)
    const settings = { ...(old.settings || {}), initiator: req.body?.initiator || 'operator' }

    const err = validateSettings(moduleKey, settings)
    if (err) return res.status(400).json({ ok: false, error: err })
    const picked = await resolveUsableAccounts(settings, moduleKey, req.body?.skipUnavailable === true)
    if (!picked.ok) return res.status(409).json(picked.payload)
    settings.accountIds = picked.accountIds

    const { store: s, task, worker } = startModuleTask(moduleKey, settings)
    task.initiator = settings.initiator
    // Перезапуск создаёт НОВУЮ задачу — владельца надо проставить заново, иначе
    // она станет ничьей и списываться будет с общего кошелька.
    task.userId = req.header('x-user-id') || old.userId || ''
    task.goalId = settings.goalId ?? null
    task.restartOf = id
    try {
      await s.saveTask(task)
      const { startWorker } = await import('./workers.js')
      startWorker(task.id, s, worker)
      const { appendAudit } = await import('../lib/auditLog.js')
      await appendAudit({
        action: 'task.restart',
        module: moduleKey,
        initiator: task.initiator,
        scope: { taskId: task.id, accounts: settings.accountIds || [] },
        reason: `Перезапуск задачи ${id}`,
      }).catch(() => {})
      res.json({ ok: true, task: s.taskToDto(task) })
    } catch (e) {
      releaseTaskLocks(task.id)
      throw e
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

/**
 * Пресеты модуля — это сохранённые `settings`: промпты, цель, список аккаунтов, тексты
 * рассылки. Файл пресетов один на модуль, владельца у записи не было, и клиент читал
 * заготовки соседа целиком (а `DELETE` ниже — сносил их).
 *
 * Пресеты, сохранённые до этого поля, остаются без владельца — их видит только админ
 * (общее правило `ownedForRequest`). Поле `owner` рядом — это НЕ владелец, а свободная
 * подпись «чей пресет» из §7, её вводит человек, доступ по ней считать нельзя.
 */
modulesRouter.get('/:moduleKey/presets', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const presets = await ownedForRequest(req, await store.loadPresets())
    res.json({ ok: true, presets })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.post('/:moduleKey/presets', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { name, settings, color, owner } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название' })
    const all = await store.loadPresets()
    const mine = await ownedForRequest(req, all)
    const foreign = all.filter((p) => !mine.includes(p))
    // Дедуп по имени и потолок в 20 штук считаем ВНУТРИ своих пресетов: файл общий, и
    // раньше клиент, сохранив «Прогрев», затирал одноимённую заготовку соседа, а после
    // двадцатой — выдавливал чужие из файла совсем.
    const filtered = mine.filter((p) => p.name !== name.trim())
    // §7: цветовая метка + подпись «чей пресет» (свободный текст, ≤40) + владелец записи.
    /*
     * MR-196: у записи два разных «чей».
     *
     * `userId` — ПРОСТРАНСТВО: по нему шаблон виден всей команде, и это правильно —
     * заказчик подтвердил, что шаблоны общие (админ видит шаблон суба и наоборот).
     * Но по нему же нельзя понять, кто шаблон завёл: у админа и у его сотрудника
     * `userId` один и тот же, и проверка владения пропускала обоих. Отсюда и дыра —
     * сотрудник переименовывал и удалял шаблон администратора обычной кнопкой.
     *
     * `authorId` — ЧЕЛОВЕК. Правит и удаляет только он.
     */
    const автор = await requesterContext(req)
    const preset = {
      id: `pr_${Date.now()}`,
      name: name.trim(),
      settings,
      userId: scope.ownerId || undefined,
      authorId: автор.id || undefined,
      createdAt: Date.now(),
      ...(typeof color === 'string' && color ? { color: color.slice(0, 20) } : {}),
      ...(typeof owner === 'string' && owner.trim() ? { owner: owner.trim().slice(0, 40) } : {}),
    }
    filtered.unshift(preset)
    await store.savePresets([...filtered.slice(0, 20), ...foreign])
    res.json({ ok: true, preset })
  } catch (err) {
    // Наружу — человеческий текст: сообщение базы («Could not find the 'author_id' column
    // of 'module_presets' in the schema cache») человеку не говорит ни что случилось, ни
    // что делать, зато рассказывает, как устроена наша схема. Подробность — в лог.
    console.error('[presets] сохранение не удалось:', err)
    res.status(400).json({ ok: false, error: 'Не удалось сохранить шаблон. Попробуйте ещё раз' })
  }
})

modulesRouter.delete('/:moduleKey/presets/:id', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const scope0 = await ownerScopeForRequest(req)
    const all = await store.loadPresets()
    const mine = await ownedForRequest(req, all)
    const victim = all.find((p) => p.id === req.params.id)
    if (!victim) return res.status(404).json({ ok: false, error: 'Пресет не найден' })
    if (!mine.includes(victim)) return res.status(403).json({ ok: false, error: 'Это не ваш пресет' })
    /*
     * MR-196: «проверку делать НА СЕРВЕРЕ, а не только прятать кнопку». Переименование
     * на клиенте — это удаление и создание заново, поэтому один этот сторож закрывает
     * оба действия сразу.
     *
     * У шаблонов, заведённых до этой правки, автора нет, и угадать его задним числом
     * нельзя. Отдавать их «всем» — оставить ту же дыру, поэтому такие достаются
     * хозяину пространства: он либо их и создал, либо отвечает за них. Тот же принцип,
     * что и для записей без владельца в `ownedForRequest`.
     */
    const кто = await requesterContext(req)
    const мой = victim.authorId ? String(victim.authorId) === String(кто.id) : String(scope0.ownerId) === String(кто.id)
    if (!мой && !кто.isAdmin) {
      return res.status(403).json({ ok: false, error: 'Чужой шаблон изменить нельзя — его создал другой сотрудник' })
    }
    const next = all.filter((p) => p.id !== req.params.id)
    await store.savePresets(next)
    // В ответ — только свои: раньше DELETE возвращал общий список и работал как ещё одно
    // чтение чужих заготовок.
    res.json({ ok: true, presets: next.filter((p) => mine.includes(p)).map(({ settings, ...meta }) => meta) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
