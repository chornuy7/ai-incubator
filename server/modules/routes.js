import { Router } from 'express'
import { getModuleStore, listModuleKeys, validateSettings, startModuleTask, stopModuleTask } from './registry.js'
import { releaseTaskLocks } from '../lib/accountLocks.js'
import { assertAccountsAssignable } from '../accountsMeta.js'
import { assertNoHotLeadConflict } from '../leads.js'

export const modulesRouter = Router()

modulesRouter.get('/', (_req, res) => {
  res.json({ ok: true, modules: listModuleKeys() })
})

// Агрегат всех задач по всем модулям (дашборд «Задачи», §3.9). До /:moduleKey/tasks.
modulesRouter.get('/tasks', async (_req, res) => {
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
    res.json({ ok: true, tasks: all })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

modulesRouter.get('/:moduleKey/tasks', async (req, res) => {
  try {
    const store = getModuleStore(req.params.moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const tasks = await store.listTasks()
    res.json({ ok: true, tasks })
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
    res.json({ ok: true, task: store.taskToDto(task) })
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

    // Guard безопасного назначения (§3.2/§3.3): не отдаём непрогретые/занятые статусом профили.
    const assignErr = await assertAccountsAssignable(settings.accountIds, moduleKey)
    if (assignErr) return res.status(409).json({ ok: false, error: assignErr })
    // Guard «горячий лид» (§3.3/§4): не забираем аккаунт из активного диалога в другой модуль.
    const hotErr = await assertNoHotLeadConflict(settings.accountIds, moduleKey)
    if (hotErr) return res.status(409).json({ ok: false, error: hotErr })

    const { store, task, worker } = startModuleTask(moduleKey, settings)
    task.initiator = settings.initiator || 'operator' // §3.9: кто запустил
    task.goalId = settings.goalId ?? null // §3.6: к какой цели
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
      res.json({ ok: true, task: store.taskToDto(task) })
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

// Перезапуск задачи с её же настройками (§3.9 трекер: restart). Создаёт НОВУЮ задачу.
modulesRouter.post('/:moduleKey/tasks/:id/restart', async (req, res) => {
  try {
    const { moduleKey, id } = req.params
    const store = getModuleStore(moduleKey)
    if (!store) return res.status(404).json({ ok: false, error: 'Модуль не найден' })
    const old = await store.loadTask(id)
    if (!old) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    const settings = { ...(old.settings || {}), initiator: req.body?.initiator || 'operator' }

    const err = validateSettings(moduleKey, settings)
    if (err) return res.status(400).json({ ok: false, error: err })
    const assignErr = await assertAccountsAssignable(settings.accountIds, moduleKey)
    if (assignErr) return res.status(409).json({ ok: false, error: assignErr })

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
    const { name, settings } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название' })
    const presets = await store.loadPresets()
    // Тот же name перезаписывает пресет, а не плодит дубли.
    const filtered = presets.filter((p) => p.name !== name.trim())
    const preset = { id: `pr_${Date.now()}`, name: name.trim(), settings, createdAt: Date.now() }
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
