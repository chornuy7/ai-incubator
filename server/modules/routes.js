import { Router } from 'express'
import { getModuleStore, listModuleKeys, validateSettings, startModuleTask, stopModuleTask } from './registry.js'
import { releaseTaskLocks } from '../lib/accountLocks.js'

export const modulesRouter = Router()

modulesRouter.get('/', (_req, res) => {
  res.json({ ok: true, modules: listModuleKeys() })
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

    const { store, task, worker } = startModuleTask(moduleKey, settings)
    try {
      await store.saveTask(task)
      const { startWorker } = await import('./workers.js')
      startWorker(task.id, store, worker)
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
    const store = getModuleStore(req.params.moduleKey)
    res.json({ ok: true, task: store.taskToDto(task) })
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
