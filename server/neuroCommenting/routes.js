import { Router } from 'express'
import {
  createTask,
  saveTask,
  loadTask,
  listTasks,
  taskToDto,
  loadPresets,
  savePresets,
} from './taskStore.js'
import { startTaskWorker, stopTaskWorker } from './worker.js'
import { tryAcquireLocks, releaseTaskLocks } from '../lib/accountLocks.js'

export const neuroCommentingRouter = Router()

neuroCommentingRouter.get('/tasks', async (_req, res) => {
  try {
    const tasks = await listTasks()
    res.json({ ok: true, tasks })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.get('/tasks/:id', async (req, res) => {
  try {
    const task = await loadTask(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    res.json({ ok: true, task: taskToDto(task) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.post('/tasks', async (req, res) => {
  try {
    const settings = req.body?.settings ?? req.body
    if (!settings?.accountIds?.length) {
      return res.status(400).json({ ok: false, error: 'Выберите хотя бы один аккаунт' })
    }
    if (!settings?.channels?.length) {
      return res.status(400).json({ ok: false, error: 'Добавьте хотя бы один канал' })
    }

    const task = createTask(settings)
    const lockErr = tryAcquireLocks(settings.accountIds, 'neuro-commenting', task.id)
    if (lockErr) return res.status(409).json({ ok: false, error: lockErr })

    try {
      await saveTask(task)
      startTaskWorker(task)
      res.json({ ok: true, task: taskToDto(task) })
    } catch (err) {
      releaseTaskLocks(task.id)
      throw err
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.post('/tasks/:id/stop', async (req, res) => {
  try {
    const task = await stopTaskWorker(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    res.json({ ok: true, task: taskToDto(task) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.get('/presets', async (_req, res) => {
  try {
    const presets = await loadPresets()
    res.json({ ok: true, presets })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.post('/presets', async (req, res) => {
  try {
    const { name, settings } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название пресета' })
    const presets = await loadPresets()
    const preset = { id: `pr_${Date.now()}`, name: name.trim(), settings, createdAt: Date.now() }
    presets.unshift(preset)
    await savePresets(presets.slice(0, 20))
    res.json({ ok: true, preset })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.get('/history', async (_req, res) => {
  try {
    const tasks = await listTasks()
    const history = []
    for (const t of tasks.slice(0, 10)) {
      const full = await loadTask(t.id)
      if (full?.commentHistory?.length) history.push(...full.commentHistory)
    }
    history.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    res.json({ ok: true, history: history.slice(0, 100) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})
