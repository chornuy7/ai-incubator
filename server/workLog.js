/**
 * Учёт рабочего времени операторов (§8.1). Сессия труда = вход→выход.
 * clockIn при логине, clockOut при выходе; открытая сессия учитывается «вживую».
 * Хранение — JSON data/worklog.json; путь через env WORKLOG_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const FILE = process.env.WORKLOG_FILE || dataPath('worklog.json')

/** @returns {Promise<Array<{id,userId,start,end,durationMs}>>} */
export async function listWorkLog(userId) {
  const all = await readJson(FILE, [])
  const arr = Array.isArray(all) ? all : []
  return userId ? arr.filter((e) => e.userId === userId) : arr
}

/** Открытая (незакрытая) сессия юзера или null. */
function openOf(entries, userId) {
  return entries.find((e) => e.userId === userId && e.end == null) || null
}

/** Отметить вход. Идемпотентно: если сессия уже открыта — вернуть её. @param {string} userId */
export async function clockIn(userId, now = Date.now()) {
  if (!userId) return null
  const entries = await listWorkLog()
  const existing = openOf(entries, userId)
  if (existing) return existing
  const entry = { id: `wl_${crypto.randomUUID().slice(0, 8)}`, userId, start: now, end: null, durationMs: 0 }
  entries.push(entry)
  await writeJson(FILE, entries.slice(-5000)) // защита от роста
  return entry
}

/** Отметить выход: закрыть открытую сессию. @param {string} userId */
export async function clockOut(userId, now = Date.now()) {
  if (!userId) return null
  const entries = await listWorkLog()
  const open = openOf(entries, userId)
  if (!open) return null
  open.end = now
  open.durationMs = Math.max(0, now - open.start)
  await writeJson(FILE, entries)
  return open
}

function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Сводка по времени юзера: сегодня и за 7 дней (с учётом открытой сессии «вживую»).
 * @param {string} userId @param {number} [now]
 * @returns {Promise<{ todayMs:number, weekMs:number, open:boolean, since:number|null }>}
 */
export async function workSummary(userId, now = Date.now()) {
  const entries = await listWorkLog(userId)
  const dayStart = startOfDay(now)
  const weekStart = now - 7 * 24 * 60 * 60 * 1000
  let todayMs = 0
  let weekMs = 0
  let open = false
  let since = null
  for (const e of entries) {
    const end = e.end == null ? now : e.end
    if (e.end == null) { open = true; since = e.start }
    const dur = Math.max(0, end - e.start)
    // Доля сессии, попадающая в окно (простая аппроксимация — по началу сессии).
    if (e.start >= dayStart) todayMs += dur
    if (e.start >= weekStart) weekMs += dur
  }
  return { todayMs, weekMs, open, since }
}

/** Сводка по всем юзерам (для страницы «Пользователи»). @param {string[]} userIds */
export async function summariesFor(userIds = [], now = Date.now()) {
  /** @type {Record<string, {todayMs:number,weekMs:number,open:boolean,since:number|null}>} */
  const out = {}
  for (const id of userIds) out[id] = await workSummary(id, now)
  return out
}
