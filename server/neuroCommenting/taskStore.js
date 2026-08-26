import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const NC_DATA_DIR = path.join(__dirname, '..', 'data', 'neuro-commenting')
export const TASKS_DIR = path.join(NC_DATA_DIR, 'tasks')
export const PRESETS_FILE = path.join(NC_DATA_DIR, 'presets.json')

async function ensureDirs() {
  await fs.mkdir(TASKS_DIR, { recursive: true })
}

export function newTaskId() {
  return `nc_${crypto.randomUUID().slice(0, 8)}`
}

export function newLogId() {
  return crypto.randomUUID().slice(0, 8)
}

/** @param {string} taskId */
function taskPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`)
}

/** @param {object} task */
export async function saveTask(task) {
  await ensureDirs()
  task.updatedAt = Date.now()
  await fs.writeFile(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8')
}

/** @param {string} taskId */
export async function loadTask(taskId) {
  try {
    const raw = await fs.readFile(taskPath(taskId), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function listTasks() {
  await ensureDirs()
  const files = await fs.readdir(TASKS_DIR)
  const tasks = []
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(path.join(TASKS_DIR, f), 'utf8')
      const t = JSON.parse(raw)
      tasks.push({
        id: t.id,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        progress: t.progress,
        settings: { accountIds: t.settings?.accountIds, channels: t.settings?.channels },
      })
    } catch {
      /* skip corrupt */
    }
  }
  tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return tasks
}

/** @param {object} task @param {'info'|'success'|'warning'|'error'} level @param {string} message @param {string} [account] */
export async function appendLog(task, level, message, account) {
  const entry = {
    id: newLogId(),
    ts: new Date().toISOString(),
    level,
    message,
    ...(account ? { account } : {}),
  }
  task.logs = task.logs || []
  task.logs.unshift(entry)
  if (task.logs.length > 500) task.logs.length = 500
  await saveTask(task)
  return entry
}

/** @param {object} task @param {object} item */
export async function appendCommentHistory(task, item) {
  task.commentHistory = task.commentHistory || []
  task.commentHistory.unshift(item)
  if (task.commentHistory.length > 200) task.commentHistory.length = 200
  await saveTask(task)
}

/** @param {object} settings */
export function createTask(settings) {
  return {
    id: newTaskId(),
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stopRequested: false,
    settings,
    progress: { done: 0, total: settings.maxComments || 100, commentsSent: 0 },
    logs: [],
    commentHistory: [],
    accountStats: {},
    commentedKeys: [],
  }
}

/*
 * Шаблоны живут в общей базе (26.08). Файл остался фолбэком для локального запуска и
 * тестов и точкой отката: раньше это было ЕДИНСТВЕННОЕ хранилище, и наборы шаблонов
 * расходились между локальной копией и сервером.
 */
const PRESET_MODULE = 'neuro-commenting'

async function readPresetsFile() {
  try {
    const raw = await fs.readFile(PRESETS_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}
async function writePresetsFile(presets) {
  await ensureDirs()
  await fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8')
}

// Переноса файловых шаблонов здесь нет намеренно — он делается осознанно и на сервере
// (`node server/scripts/presets-to-db.mjs`). Причина — в комментарии lib/taskStore.js.
export async function loadPresets() {
  const { loadModulePresets } = await import('../modulePresets.js')
  return loadModulePresets(PRESET_MODULE, readPresetsFile)
}

/** @param {object[]} presets */
export async function savePresets(presets) {
  const { saveModulePresets } = await import('../modulePresets.js')
  return saveModulePresets(PRESET_MODULE, presets, writePresetsFile)
}

/** Public DTO for API */
export function taskToDto(task) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: task.progress,
    settings: task.settings,
    logs: task.logs || [],
    commentHistory: task.commentHistory || [],
    accountStats: task.accountStats || {},
  }
}
