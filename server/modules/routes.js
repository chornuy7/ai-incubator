import { Router } from 'express'
import { getModuleStore, listModuleKeys, validateSettings, startModuleTask, stopModuleTask, pauseModuleTask, resumeModuleTask } from './registry.js'
import { releaseTaskLocks } from '../lib/accountLocks.js'
import { assertAccountsAssignable, checkAccountsAssignable, loadAllMeta } from '../accountsMeta.js'

/**
 * C2 (§5.1): модули, которые обращаются к ИИ и потому тратят монеты. Парсеры сюда
 * НЕ входят — они только читают Telegram, ничего не генерируют, и блокировать сбор
 * данных из-за нулевого баланса было бы произволом.
 */
const AI_MODULES = new Set(['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mailing'])
import { assertNoHotLeadConflict, assertActiveDialogLimit } from '../leads.js'
import { findDuplicateActiveTask } from '../lib/taskDedup.js'
import { getGoal, isGoalExpired } from '../goals.js'
import { WARMING_MODULES, canStopWarming } from '../lib/safetyLimits.js'
import { splitAudience } from '../lib/mailingAudience.js'
import { canEditTask, pickEditableSettings } from '../lib/taskEdit.js'
import { isAdminRequest, tasksForRequest, canTouchTask } from '../lib/accessGuard.js'

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
    res.json({ ok: true, task: store.taskToDto(task) })
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

    // C2 (§5.1): при нулевом балансе боевые модули не запускаем. Парсеры пропускаем —
    // они не обращаются к ИИ и ничего не тратят, а запрет на сбор данных из-за монет
    // выглядел бы произволом. Проверяем ДО создания задачи: узнать о нуле из логов
    // уже запущенной рассылки — худший из возможных способов.
    if (AI_MODULES.has(moduleKey)) {
      const { getBalance } = await import('../balance.js')
      // Считаем баланс ТОГО, кто запускает: кошельки у пользователей разные,
      // и запуск на чужие монеты был бы дырой в биллинге.
      const { coins } = await getBalance(req.header('x-user-id'))
      if (coins <= 0) {
        return res.status(402).json({
          ok: false,
          error: 'Закончились монеты — боевые модули остановлены. Пополните баланс, чтобы продолжить.',
          needTopUp: true,
        })
      }
    }

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
    task.settings = { ...task.settings, ...settings }
    await store.saveTask(task)

    const { appendAudit } = await import('../lib/auditLog.js')
    await appendAudit({
      action: 'task.edit',
      module: req.params.moduleKey,
      initiator: req.body?.initiator || 'operator',
      scope: { taskId: req.params.id },
      reason: `Правка задачи на паузе: ${Object.keys(settings).join(', ')}`,
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
    const settings = { ...(old.settings || {}), initiator: req.body?.initiator || 'operator' }

    const err = validateSettings(moduleKey, settings)
    if (err) return res.status(400).json({ ok: false, error: err })
    const picked = await resolveUsableAccounts(settings, moduleKey, req.body?.skipUnavailable === true)
    if (!picked.ok) return res.status(409).json(picked.payload)
    settings.accountIds = picked.accountIds

    const { store: s, task, worker } = startModuleTask(moduleKey, settings)
    task.initiator = settings.initiator
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

modulesRouter.get('/:moduleKey/presets', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const presets = await store.loadPresets()
    res.json({ ok: true, presets })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.post('/:moduleKey/presets', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const { name, settings, color, owner } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название' })
    const presets = await store.loadPresets()
    // Тот же name перезаписывает пресет, а не плодит дубли.
    const filtered = presets.filter((p) => p.name !== name.trim())
    // §7: цветовая метка + владелец персонального пресета (нормализуем к строке ≤40).
    const preset = {
      id: `pr_${Date.now()}`,
      name: name.trim(),
      settings,
      createdAt: Date.now(),
      ...(typeof color === 'string' && color ? { color: color.slice(0, 20) } : {}),
      ...(typeof owner === 'string' && owner.trim() ? { owner: owner.trim().slice(0, 40) } : {}),
    }
    filtered.unshift(preset)
    await store.savePresets(filtered.slice(0, 20))
    res.json({ ok: true, preset })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.delete('/:moduleKey/presets/:id', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const presets = await store.loadPresets()
    const next = presets.filter((p) => p.id !== req.params.id)
    await store.savePresets(next)
    res.json({ ok: true, presets: next.map(({ settings, ...meta }) => meta) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
