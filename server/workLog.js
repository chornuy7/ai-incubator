/**
 * Учёт рабочего времени операторов (§8.1). Сессия труда = вход→выход.
 * clockIn при логине, clockOut при выходе; открытая сессия учитывается «вживую».
 *
 * С 27.08 (MR-186) хранится в ОБЩЕЙ БАЗЕ (`work_log`). До этого стор писал только в
 * data/worklog.json, ветки Supabase у него не было. По этим записям считают отработанное
 * время: файл на одной машине — смены нечем подтвердить, а при втором инстансе человек
 * отмечался на одном сервере и выходил через другой, из-за чего сессия оставалась
 * незакрытой навсегда, а её половина не попадала в отчёт.
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

/**
 * Путь считаем ЛЕНИВО, при каждом обращении.
 *
 * Раньше он вычислялся один раз при импорте модуля — и тест, выставивший WORKLOG_FILE
 * уже после того, как модуль подтянулся по цепочке импортов, писал в БОЕВОЙ файл.
 * Ровно так в рабочие цели однажды попали четыре тестовых (см. goals.js).
 */
const workLogFile = () => process.env.WORKLOG_FILE || dataPath('worklog.json')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/**
 * Таблицы ещё нет (миграция не накатана) — не роняем вход в систему. Отметка времени
 * важна, но не настолько, чтобы из-за неё человек не смог залогиниться.
 */
const isMissingTable = (error) =>
  !!error && /work_log|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

const fromRow = (r) => ({
  id: r.id,
  userId: r.user_id,
  start: Number(r.start_at) || 0,
  end: r.end_at == null ? null : Number(r.end_at),
  durationMs: Number(r.duration_ms) || 0,
})

/** @returns {Promise<Array<{id,userId,start,end,durationMs}>>} */
export async function listWorkLog(userId) {
  const db = sb()
  if (db) {
    let q = db.from('work_log').select('*').order('start_at', { ascending: true })
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать учёт времени: ${error.message}`)
    }
    return (data || []).map(fromRow)
  }
  const all = await readJson(workLogFile(), [])
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
  const db = sb()
  const entry = { id: `wl_${crypto.randomUUID().slice(0, 8)}`, userId, start: now, end: null, durationMs: 0 }
  if (db) {
    // Ищем открытую сессию точечным запросом, а не чтением всего лога: вход происходит
    // на каждый логин, и вычитывать ради него все смены всех людей незачем.
    const { data, error } = await db.from('work_log').select('*').eq('user_id', userId).is('end_at', null).limit(1)
    if (error) {
      if (isMissingTable(error)) return null
      throw new Error(`Не удалось отметить вход: ${error.message}`)
    }
    if (data?.length) return fromRow(data[0])
    const { error: insErr } = await db.from('work_log').insert({
      id: entry.id, user_id: userId, start_at: now, end_at: null, duration_ms: 0,
    })
    if (insErr && !isMissingTable(insErr)) throw new Error(`Не удалось отметить вход: ${insErr.message}`)
    return entry
  }
  const entries = await listWorkLog()
  const existing = openOf(entries, userId)
  if (existing) return existing
  entries.push(entry)
  // Потолок нужен только файлу: он переписывается целиком, и без обрезки рос бы вечно.
  await writeJson(workLogFile(), entries.slice(-5000))
  return entry
}

/** Отметить выход: закрыть открытую сессию. @param {string} userId */
export async function clockOut(userId, now = Date.now()) {
  if (!userId) return null
  const db = sb()
  if (db) {
    const { data, error } = await db.from('work_log').select('*').eq('user_id', userId).is('end_at', null).limit(1)
    if (error) {
      if (isMissingTable(error)) return null
      throw new Error(`Не удалось отметить выход: ${error.message}`)
    }
    if (!data?.length) return null
    const open = fromRow(data[0])
    const durationMs = Math.max(0, now - open.start)
    const { error: updErr } = await db.from('work_log').update({ end_at: now, duration_ms: durationMs }).eq('id', open.id)
    if (updErr && !isMissingTable(updErr)) throw new Error(`Не удалось отметить выход: ${updErr.message}`)
    return { ...open, end: now, durationMs }
  }
  const entries = await listWorkLog()
  const open = openOf(entries, userId)
  if (!open) return null
  open.end = now
  open.durationMs = Math.max(0, now - open.start)
  await writeJson(workLogFile(), entries)
  return open
}

/**
 * Потолок для НЕЗАКРЫТОЙ сессии. Человек не работает 98 часов подряд — такая запись
 * означает, что закрытие по неактивности не отработало (или вкладку не закрыли).
 * Считаем максимум рабочую смену, остальное в статистику не пускаем.
 */
export const OPEN_SESSION_CAP_MS = 12 * 60 * 60 * 1000

/** Пересечение отрезка [aStart,aEnd] с окном [wStart,wEnd] в миллисекундах. */
function overlap(aStart, aEnd, wStart, wEnd) {
  return Math.max(0, Math.min(aEnd, wEnd) - Math.max(aStart, wStart))
}

function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Свести уже прочитанные записи одного человека. Вынесено, чтобы сводка по многим людям
 *  считалась из ОДНОГО чтения, а не по запросу на каждого. */
function summarize(entries, now) {
  const dayStart = startOfDay(now)
  const weekStart = now - 7 * 24 * 60 * 60 * 1000
  let todayMs = 0
  let weekMs = 0
  let open = false
  let since = null
  for (const e of entries) {
    // Открытая сессия росла КРУГЛОСУТОЧНО: `end = now` без потолка давал записи вроде
    // «одна сессия длиной 98 часов», и рядом с «сегодня 5м» появлялось «7 дней 149ч».
    // Это учёт календаря, а не работы. Ограничиваем открытую сессию разумным
    // потолком — дальше считаем, что человек просто не разлогинился (тест 7.9).
    const rawEnd = e.end == null ? now : e.end
    const end = e.end == null ? Math.min(now, e.start + OPEN_SESSION_CAP_MS) : rawEnd
    if (e.end == null) { open = true; since = e.start }
    // Считаем ПЕРЕСЕЧЕНИЕ сессии с окном, а не всю длительность по её началу:
    // раньше сессия, начавшаяся вчера, целиком падала в «неделю», а ночная — целиком
    // в «сегодня» или не попадала вовсе.
    todayMs += overlap(e.start, end, dayStart, now)
    weekMs += overlap(e.start, end, weekStart, now)
  }
  return { todayMs, weekMs, open, since }
}

/**
 * Сводка по времени юзера: сегодня и за 7 дней (с учётом открытой сессии «вживую»).
 * @param {string} userId @param {number} [now]
 * @returns {Promise<{ todayMs:number, weekMs:number, open:boolean, since:number|null }>}
 */
export async function workSummary(userId, now = Date.now()) {
  return summarize(await listWorkLog(userId), now)
}

/** Сводка по всем юзерам (для страницы «Пользователи»). @param {string[]} userIds */
export async function summariesFor(userIds = [], now = Date.now()) {
  /** @type {Record<string, {todayMs:number,weekMs:number,open:boolean,since:number|null}>} */
  const out = {}
  if (!userIds.length) return out

  const db = sb()
  // Одним запросом на всех, а не запросом на человека: на странице «Пользователи» людей
  // десятки, и цикл запросов растянул бы её открытие на секунды.
  let entries = []
  if (db) {
    const { data, error } = await db.from('work_log').select('*').in('user_id', userIds)
    if (error && !isMissingTable(error)) throw new Error(`Не удалось прочитать учёт времени: ${error.message}`)
    entries = (data || []).map(fromRow)
  } else {
    entries = await listWorkLog()
  }

  const byUser = new Map(userIds.map((id) => [id, []]))
  for (const e of entries) if (byUser.has(e.userId)) byUser.get(e.userId).push(e)
  for (const id of userIds) out[id] = summarize(byUser.get(id) || [], now)
  return out
}
