import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.join(__dirname, '..', 'data', 'modules')

/** @param {string} moduleKey @param {string} idPrefix */
export function createTaskStore(moduleKey, idPrefix) {
  const baseDir = path.join(DATA_ROOT, moduleKey)
  const tasksDir = path.join(baseDir, 'tasks')
  const presetsFile = path.join(baseDir, 'presets.json')

  async function ensureDirs() {
    await fs.mkdir(tasksDir, { recursive: true })
  }

  function newTaskId() {
    return `${idPrefix}_${crypto.randomUUID().slice(0, 8)}`
  }

  function newLogId() {
    return crypto.randomUUID().slice(0, 8)
  }

  function taskPath(taskId) {
    return path.join(tasksDir, `${taskId}.json`)
  }

  /** @param {object} task */
  /**
   * @param {object} task
   * @param {{ control?: boolean }} [opts] control:true — операция управления (resume и т.п.),
   *   которой РАЗРЕШЕНО сбрасывать флаги stop/pause. Обычные сохранения воркера (прогресс,
   *   логи) НЕ должны затирать выставленные извне stopRequested/pauseRequested (гонка §3.9).
   */
  async function saveTask(task, opts = {}) {
    await ensureDirs()
    task.updatedAt = Date.now()
    task.moduleKey = moduleKey
    if (!opts.control) {
      try {
        const prev = JSON.parse(await fs.readFile(taskPath(task.id), 'utf8'))
        if (prev.stopRequested) task.stopRequested = true
        if (prev.pauseRequested) task.pauseRequested = true
      } catch { /* нет файла — первая запись */ }
    }
    await fs.writeFile(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8')
  }

  /** @param {string} taskId */
  async function loadTask(taskId) {
    try {
      const raw = await fs.readFile(taskPath(taskId), 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async function listTasks() {
    await ensureDirs()
    const files = await fs.readdir(tasksDir)
    const tasks = []
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(tasksDir, f), 'utf8')
        const t = JSON.parse(raw)
        tasks.push({
          id: t.id,
          moduleKey,
          status: t.status,
          initiator: t.initiator || null,
          // Владелец нужен фильтру «свои задачи» (§8.1): без него дашборд не сможет
          // отличить чужой запуск от своего и покажет либо всё, либо ничего.
          userId: t.userId || '',
          spentCoins: t.spentCoins || 0, // §5.1: во сколько обошёлся ЭТОТ запуск
          // Счётчик ошибок — не сами логи: файл здесь и так читается целиком, а
          // админке нужно «где болит», не таща в список весь журнал каждой задачи.
          errors: (t.logs || []).reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0),
          lastError: (t.logs || []).find((l) => l.level === 'error')?.message || '',
          // Пауза из-за денег отличается от паузы рукой: первую чинит пополнение.
          // Ищем ТОЧНУЮ фразу и только в последней записи: широкий поиск «монет|баланс»
          // по всему журналу ловил и строку возврата «Возврат N монет», из-за чего
          // задача, поставленная на паузу рукой, показывалась как «ждёт пополнения».
          pausedByCoins: t.status === 'paused'
            && /Закончились монеты/i.test(String((t.logs || [])[0]?.message || '')),
          // MR-134: сколько FloodWait поймали аккаунты этой задачи — сигнал «упираемся в лимиты».
          floodWaits: Object.values(t.accountStats || {}).reduce((n, s) => n + (Number(s?.floodWaits) || 0), 0),
          goalId: t.goalId ?? t.settings?.goalId ?? null,
          campaignId: t.campaignId ?? null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          progress: t.progress,
          settings: t.settings,
        })
      } catch {
        /* skip */
      }
    }
    tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return tasks
  }

  /**
   * @param {object} task @param {'info'|'success'|'warning'|'error'} level @param {string} message
   * @param {string} [account] @param {{ code?: string, reason?: string }} [opts]
   * Поля Фазы 0 (§3.1): `module`/`initiator`/`ts` берём из контекста задачи, `code`/`reason` — опц.
   */
  async function appendLog(task, level, message, account, opts = {}) {
    const entry = {
      id: newLogId(),
      ts: new Date().toISOString(),
      level,
      message,
      module: task.moduleKey,              // из какого модуля (Фаза 0)
      initiator: task.initiator || 'system', // кто инициировал задачу (Фаза 0)
      ...(account ? { account } : {}),
      ...(opts.code ? { code: String(opts.code) } : {}),      // машинный код события
      ...(opts.reason ? { reason: String(opts.reason) } : {}), // причина
    }
    task.logs = task.logs || []
    task.logs.unshift(entry)
    if (task.logs.length > 500) task.logs.length = 500
    await saveTask(task)
    return entry
  }

  /** @param {object} task @param {object} item @param {string} [field='history'] */
  async function appendHistory(task, item, field = 'history') {
    task[field] = task[field] || []
    task[field].unshift(item)
    if (task[field].length > 200) task[field].length = 200
    await saveTask(task)
  }

  /** @param {object} settings @param {object} [init] */
  function createTask(settings, init = {}) {
    return {
      id: newTaskId(),
      moduleKey,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stopRequested: false,
      settings,
      progress: init.progress ?? { done: 0, total: settings.maxActions ?? 100, actionsDone: 0 },
      logs: [],
      history: [],
      results: [],
      accountStats: {},
      actionKeys: [],
      ...init,
    }
  }

  async function loadPresets() {
    try {
      const raw = await fs.readFile(presetsFile, 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  /** @param {object[]} presets */
  async function savePresets(presets) {
    await ensureDirs()
    await fs.writeFile(presetsFile, JSON.stringify(presets, null, 2), 'utf8')
  }

  /** @param {object} task */
  function taskToDto(task) {
    return {
      id: task.id,
      moduleKey: task.moduleKey || moduleKey,
      status: task.status,
      initiator: task.initiator || null,
      userId: task.userId || '',
      spentCoins: task.spentCoins || 0,
      goalId: task.goalId ?? task.settings?.goalId ?? null,
      campaignId: task.campaignId ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      progress: task.progress,
      settings: task.settings,
      logs: task.logs || [],
      history: task.history || [],
      commentHistory: task.commentHistory || task.history || [],
      results: task.results || [],
      accountStats: task.accountStats || {},
    }
  }

  return {
    moduleKey,
    saveTask,
    loadTask,
    listTasks,
    appendLog,
    appendHistory,
    createTask,
    loadPresets,
    savePresets,
    taskToDto,
  }
}
