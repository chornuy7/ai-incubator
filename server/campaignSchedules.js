/**
 * Расписание кампаний (§3.9): запланировать запуск кампании на время + вкл/выкл + повтор.
 * Хранение — JSON data/campaign-schedules.json; путь через env CAMPAIGN_SCHEDULES_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { listStore } from './lib/tableStore.js'
import { toDbTime, fromDbTime, fromDbTimeOrNull } from './lib/dbTime.js'

const FILE = process.env.CAMPAIGN_SCHEDULES_FILE || dataPath('campaign-schedules.json')

// §10.2: расписания кампаний — в БД (планировщик может работать не на одном инстансе).
const schedStore = listStore({
  table: 'campaign_schedules',
  file: () => FILE,
  /*
   * MR-290: «когда запустить» и «что вышло» — колонками, `body` остаётся json.
   *
   * Это разные вещи, и разделены они не по вкусу. Время запуска, повтор и включённость
   * — то, по чему планировщик ВЫБИРАЕТ, что пора запускать: такой отбор обязан идти по
   * индексу, а не разбором json у каждой строки. А `body` — заявка на будущую кампанию
   * в том виде, в каком её принимает API кампаний: её форма принадлежит API, а не этой
   * таблице, и раскладывать её по колонкам значило бы менять схему при каждой правке
   * параметров кампании.
   */
  toRow: (x) => { const { id, name, userId, createdAt, updatedAt, ...data } = x; return {
    id, name: name || '', data, user_id: userId || null,
    run_at: toDbTime(data.runAt),
    repeat: data.repeat === 'daily' ? 'daily' : 'none',
    enabled: data.enabled !== false,
    last_run_at: toDbTime(data.lastRunAt),
    body: data.body ?? null,
    last_result: data.lastResult ?? null,
    created_at: new Date(createdAt || Date.now()).toISOString(),
    updated_at: new Date(updatedAt || Date.now()).toISOString(),
  } },
  fromRow: (r) => {
    const s = {
      ...(r.data || {}), id: r.id, name: r.name || '', userId: r.user_id || undefined,
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
      updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    }
    if (r.run_at != null) s.runAt = fromDbTime(r.run_at)
    if (r.repeat) s.repeat = r.repeat
    if (r.enabled != null) s.enabled = r.enabled !== false
    // `lastRunAt` и `lastResult` различают «ещё не запускалось» и «запускалось»: NULL
    // здесь значащий, поэтому в ноль он не сворачивается.
    if (r.last_run_at !== undefined) s.lastRunAt = fromDbTimeOrNull(r.last_run_at)
    if (r.body != null) s.body = r.body
    if (r.last_result !== undefined) s.lastResult = r.last_result ?? null
    return s
  },
})
const DAY = 24 * 60 * 60 * 1000

export async function listSchedules() {
  const arr = await schedStore.readAll()
  return Array.isArray(arr) ? arr : []
}

/** @param {{ name?, body?, runAt?, repeat?, enabled? }} input */
export async function createSchedule(input = {}) {
  if (!input.body || typeof input.body !== 'object') throw new Error('Нет параметров кампании (body)')
  const all = await listSchedules()
  const sched = {
    id: `csch_${crypto.randomUUID().slice(0, 8)}`,
    name: String(input.name ?? '').trim() || 'Кампания по расписанию',
    body: input.body,
    runAt: Number(input.runAt) || Date.now(),
    repeat: input.repeat === 'daily' ? 'daily' : 'none',
    enabled: input.enabled !== false,
    userId: String(input.userId || '').trim() || undefined, // §11.3: кто создал расписание

    lastRunAt: null,
    lastResult: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(sched)
  await schedStore.writeAll(all)
  return sched
}

/** @param {string} id @param {object} patch */
export async function updateSchedule(id, patch = {}) {
  const all = await listSchedules()
  const i = all.findIndex((s) => s.id === id)
  if (i === -1) return null
  if (patch.name !== undefined) all[i].name = String(patch.name).trim() || all[i].name
  if (patch.enabled !== undefined) all[i].enabled = !!patch.enabled
  if (patch.runAt !== undefined) all[i].runAt = Number(patch.runAt) || all[i].runAt
  if (patch.repeat !== undefined) all[i].repeat = patch.repeat === 'daily' ? 'daily' : 'none'
  if (patch.body !== undefined && patch.body) all[i].body = patch.body
  all[i].updatedAt = Date.now()
  await schedStore.writeAll(all)
  return all[i]
}

export async function deleteSchedule(id) {
  const all = await listSchedules()
  const next = all.filter((s) => s.id !== id)
  if (next.length === all.length) return false
  await schedStore.writeAll(next)
  return true
}

/**
 * Готова ли запись к запуску. Чистая функция.
 * none — один раз (после запуска не повторяется); daily — не чаще раза в 24ч.
 * @param {object} s @param {number} now
 */
export function isDue(s, now) {
  if (!s.enabled || now < s.runAt) return false
  if (s.repeat === 'daily') return !s.lastRunAt || (now - s.lastRunAt) >= DAY
  return !s.lastRunAt // 'none' — только если ещё не запускалась
}

/** Отметить запуск: lastRunAt + результат; для 'none' — выключить (отработала). */
export async function markRun(id, now, result) {
  const all = await listSchedules()
  const i = all.findIndex((s) => s.id === id)
  if (i === -1) return null
  all[i].lastRunAt = now
  all[i].lastResult = result ?? null
  if (all[i].repeat === 'none') all[i].enabled = false
  all[i].updatedAt = now
  await schedStore.writeAll(all)
  return all[i]
}

/**
 * Тик планировщика: запускает все «созревшие» кампании через runner(body).
 * @param {(body:object)=>Promise<object>} runner @param {number} [now]
 */
export async function campaignScheduleTick(runner, now = Date.now()) {
  const all = await listSchedules()
  const fired = []
  for (const s of all) {
    if (!isDue(s, now)) continue
    let result
    try { result = await runner({ ...s.body, initiator: 'scheduler' }) }
    catch (e) { result = { error: e instanceof Error ? e.message : 'ошибка' } }
    await markRun(s.id, now, { campaignId: result?.campaignId ?? null, tasks: result?.tasks?.length ?? 0, error: result?.error ?? null })
    fired.push({ id: s.id, result })
  }
  return fired
}
