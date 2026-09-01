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
import { tasksForRequest, canTouchTask, ownedForRequest, ownerScopeForRequest, requesterContext } from '../lib/accessGuard.js'

export const neuroCommentingRouter = Router()

/**
 * ЛЕГАСИ-хранилище нейрокомментинга. Запуск отсюда закрыт (410 ниже), но чтение
 * оставалось полностью открытым: списком уходили чужие задачи с составом аккаунтов и
 * каналов, а `/history` — тексты комментариев, которые чужие аккаунты писали в чужих
 * чатах. Правило то же, что в Дашборде: свои задачи видит автор, все — админ и роль
 * с правом `allTasks`.
 *
 * Задачи этого стора владельца не хранят (поле появилось уже в общем реестре модулей),
 * поэтому на практике старые записи остаются видны только админу — привязать их к
 * какому-то клиенту задним числом нельзя.
 */
neuroCommentingRouter.get('/tasks', async (req, res) => {
  try {
    const tasks = await tasksForRequest(req, await listTasks())
    res.json({ ok: true, tasks })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.get('/tasks/:id', async (req, res) => {
  try {
    const task = await loadTask(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    // Точечный роут без гейта сводил фильтр списка к косметике: id задачи виден в логах.
    if (!(await canTouchTask(req, task))) return res.status(403).json({ ok: false, error: 'Это не ваша задача' })
    res.json({ ok: true, task: taskToDto(task) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.post('/tasks', async (req, res) => {
  // ЛЕГАСИ-путь запуска, вытесненный /api/modules/neuro-commenting/tasks. Его воркер
  // шлёт реальные комментарии, но НЕ проверяет подписку/баланс и НЕ списывает монеты —
  // то есть боевая работа шла бы бесплатно и мимо биллинга. Интерфейс сюда не ходит
  // (компонент NeuroCommentingModule не смонтирован), поэтому запуск закрыт. Чтение
  // задач/истории ниже оставлено, чтобы старые данные оставались видимы.
  return res.status(410).json({
    ok: false,
    error: 'Этот способ запуска отключён. Используйте модуль «Нейрокомментинг» — он считает подписку и монеты.',
  })
  // eslint-disable-next-line no-unreachable
  try {
    const settings = req.body?.settings ?? req.body
    if (!settings?.accountIds?.length) {
      return res.status(400).json({ ok: false, error: 'Выберите хотя бы один аккаунт' })
    }
    if (!settings?.channels?.length) {
      return res.status(400).json({ ok: false, error: 'Добавьте хотя бы один канал' })
    }
    // feature 4: min <= max
    const minC = Number(settings?.minComments ?? 0) || 0
    const maxC = Number(settings?.maxComments ?? 0) || 0
    if (minC && maxC && minC > maxC) {
      return res.status(400).json({ ok: false, error: 'Минимум комментариев больше максимума' })
    }
    const minPA = Number(settings?.minPerAccount ?? 0) || 0
    const maxPA = Number(settings?.maxPerAccount ?? 0) || 0
    if (minPA && maxPA && minPA > maxPA) {
      return res.status(400).json({ ok: false, error: 'Минимум на аккаунт больше максимума' })
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
    const existing = await loadTask(req.params.id)
    if (existing && !(await canTouchTask(req, existing))) {
      return res.status(403).json({ ok: false, error: 'Это не ваша задача' })
    }
    const task = await stopTaskWorker(req.params.id)
    if (!task) return res.status(404).json({ ok: false, error: 'Задача не найдена' })
    res.json({ ok: true, task: taskToDto(task) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// Пресеты здесь — те же сохранённые settings (промпты, каналы, аккаунты), что и в
// модульных пресетах, и лежали они одним общим файлом.
neuroCommentingRouter.get('/presets', async (req, res) => {
  try {
    const presets = await ownedForRequest(req, await loadPresets())
    res.json({ ok: true, presets })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

neuroCommentingRouter.post('/presets', async (req, res) => {
  try {
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { name, settings } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название пресета' })
    const all = await loadPresets()
    const mine = await ownedForRequest(req, all)
    const foreign = all.filter((p) => !mine.includes(p))
    // MR-196: автор — конкретный человек, а не пространство: по `userId` админа и его
    // сотрудника не различить. Пишем и здесь, иначе шаблон, заведённый через этот роут,
    // остался бы «ничьим» и попал под правило для легаси.
    const автор = await requesterContext(req)
    const preset = { id: `pr_${Date.now()}`, name: name.trim(), settings, userId: scope.ownerId || undefined, authorId: автор.id || undefined, createdAt: Date.now() }
    mine.unshift(preset)
    // Потолок в 20 считаем по своим: общий файл иначе выдавливал чужие заготовки.
    await savePresets([...mine.slice(0, 20), ...foreign])
    res.json({ ok: true, preset })
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
  }
})

// `commentHistory` — это сами тексты, отправленные чужими аккаунтами в чужие чаты.
neuroCommentingRouter.get('/history', async (req, res) => {
  try {
    const tasks = await tasksForRequest(req, await listTasks())
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
