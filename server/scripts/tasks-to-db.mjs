/**
 * MR-290: перенести задачи модулей из файлов в базу.
 *
 * До этого задача была файлом `server/data/modules/<модуль>/tasks/<id>.json`, и внутри
 * лежало всё сразу: настройки, прогресс, журнал, история, результаты, статистика по
 * аккаунтам и ключи выполненных действий.
 *
 *   node --env-file=.env server/scripts/tasks-to-db.mjs --dry        показать, что будет
 *   node --env-file=.env server/scripts/tasks-to-db.mjs              перенести
 *   node --env-file=.env server/scripts/tasks-to-db.mjs --active     только незавершённые
 *
 * ⚠️ ЗАПУСКАТЬ ПРИ ОСТАНОВЛЕННОМ СЕРВЕРЕ. Пока воркеры живы, они пишут в файлы, и
 * перенос получится с обрывом на полуслове: часть журнала уедет, часть останется.
 *
 * Файлы НЕ УДАЛЯЮТСЯ. Пока не видно, что панель работает с базой, вторая копия дороже
 * места на диске. Убрать их — отдельным решением, руками.
 *
 * Повторный запуск безопасен: у всех таблиц составной первичный ключ, вставка идёт
 * `on conflict do nothing`, поэтому уже перенесённое не задваивается.
 */
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getSupabase } from '../lib/supabase.js'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const ONLY_ACTIVE = args.has('--active')
const ACTIVE = new Set(['queued', 'running', 'paused'])
const KNOWN_STATUS = new Set(['queued', 'running', 'paused', 'done', 'error', 'stopped'])

const db = getSupabase()
if (!db) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY — подключиться не к чему.')
  process.exit(1)
}

const ROOT = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'server', 'data'), 'modules')

/** Справочник модулей: у задачи внешний ключ на него, чужой ключ вставка не пропустит. */
const { data: modRows, error: modErr } = await db.from('modules').select('key')
if (modErr) { console.error('Не удалось прочитать справочник модулей:', modErr.message); process.exit(1) }
const known = new Set((modRows || []).map((m) => m.key))

let modules = []
try {
  modules = (await fs.readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
} catch {
  console.log(`Каталога ${ROOT} нет — переносить нечего.`)
  process.exit(0)
}

const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString()
const stats = { файлов: 0, перенесено: 0, пропущено: 0, ошибок: 0, журнала: 0, событий: 0, ключей: 0 }
const проблемы = []

for (const moduleKey of modules) {
  const dir = path.join(ROOT, moduleKey, 'tasks')
  let files = []
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')) } catch { continue }
  if (!known.has(moduleKey)) {
    проблемы.push(`модуль ${moduleKey}: нет в справочнике modules — ${files.length} задач(и) НЕ перенесены`)
    stats.пропущено += files.length
    continue
  }

  for (const f of files) {
    stats.файлов++
    let task
    try { task = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) } catch (e) {
      stats.ошибок++; проблемы.push(`${moduleKey}/${f}: не разобрался — ${e.message}`); continue
    }
    if (ONLY_ACTIVE && !ACTIVE.has(task.status)) { stats.пропущено++; continue }
    if (!KNOWN_STATUS.has(task.status)) {
      // Статус ограничен проверкой в базе. Неизвестный — повод разобраться, а не
      // подставить «done» молча: задача могла остаться в работе.
      stats.ошибок++; проблемы.push(`${moduleKey}/${f}: неизвестный статус «${task.status}»`); continue
    }

    if (DRY) {
      console.log(`  · ${moduleKey}/${task.id}: ${task.status}, журнал ${(task.logs || []).length}, результатов ${(task.results || []).length}`)
      continue
    }

    try {
      const row = {
        id: task.id, module_key: moduleKey, status: task.status,
        initiator: task.initiator || null, user_id: task.userId || null,
        goal_id: task.goalId ?? task.settings?.goalId ?? null,
        campaign_id: task.campaignId ?? null,
        settings: task.settings || {},
        progress_done: Number(task.progress?.done) || 0,
        progress_total: Number(task.progress?.total) || 0,
        progress_actions: Number(task.progress?.actionsDone) || 0,
        spent_coins: Number(task.spentCoins) || 0,
        stop_requested: !!task.stopRequested, pause_requested: !!task.pauseRequested,
        resume_on_boot: !!task.resumeOnBoot, fatal_error: task.fatalError || null,
        created_at: iso(task.createdAt), updated_at: iso(task.updatedAt),
      }
      let { error } = await db.from('tasks').upsert(row, { onConflict: 'id' })
      if (error && String(error.code) === '23503') {
        // Владелец, цель или кампания могли быть удалены за время жизни задачи. Задачу
        // переносим, ссылку снимаем и говорим об этом — потерять всю задачу хуже.
        const blob = `${error.message} ${error.details || ''}`
        for (const c of ['user_id', 'goal_id', 'campaign_id']) if (blob.includes(c)) row[c] = null
        проблемы.push(`${task.id}: ссылка(и) ведут в никуда — перенесена без них`)
        ;({ error } = await db.from('tasks').upsert(row, { onConflict: 'id' }))
      }
      if (error) throw new Error(error.message)

      const logs = (task.logs || []).filter((l) => l?.id).map((l) => ({
        task_id: task.id, entry_id: String(l.id), ts: l.ts || iso(task.updatedAt),
        level: ['info', 'success', 'warning', 'error'].includes(l.level) ? l.level : 'info',
        message: String(l.message ?? ''), account_id: l.account || null,
        module_key: l.module || moduleKey, initiator: l.initiator || null,
        code: l.code || null, reason: l.reason || null,
      }))
      if (logs.length) {
        const { error: e } = await db.from('task_logs').upsert(logs, { ignoreDuplicates: true })
        if (e) throw new Error(`журнал: ${e.message}`)
        stats.журнала += logs.length
      }

      // История в файле лежит «свежее сверху», а позиция должна расти со временем —
      // разворачиваем, иначе после переноса история встанет задом наперёд.
      const events = []
      for (const field of ['history', 'commentHistory']) {
        const list = Array.isArray(task[field]) ? [...task[field]].reverse() : []
        list.forEach((payload, i) => events.push({ task_id: task.id, field, position: i, payload: payload ?? {} }))
      }
      ;(task.results || []).forEach((payload, i) => events.push({ task_id: task.id, field: 'result', position: i, payload: payload ?? {} }))
      if (events.length) {
        const { error: e } = await db.from('task_events').upsert(events, { ignoreDuplicates: true })
        if (e) throw new Error(`история и результаты: ${e.message}`)
        stats.событий += events.length
      }

      const accStats = Object.entries(task.accountStats || {}).map(([accountId, s]) => ({
        task_id: task.id, account_id: accountId,
        actions: Number(s?.actions) || 0, flood_waits: Number(s?.floodWaits) || 0, data: s || {},
      }))
      if (accStats.length) {
        const { error: e } = await db.from('task_account_stats').upsert(accStats, { onConflict: 'task_id,account_id' })
        // Аккаунт мог быть удалён — статистика по нему не повод потерять задачу.
        if (e) проблемы.push(`${task.id}: статистика по аккаунтам не перенесена — ${e.message}`)
      }

      const keys = [...new Set((task.actionKeys || []).map(String))].map((key) => ({ task_id: task.id, key }))
      if (keys.length) {
        const { error: e } = await db.from('task_action_keys').upsert(keys, { ignoreDuplicates: true })
        if (e) throw new Error(`ключи действий: ${e.message}`)
        stats.ключей += keys.length
      }

      stats.перенесено++
    } catch (e) {
      stats.ошибок++
      проблемы.push(`${moduleKey}/${task.id}: ${e.message}`)
    }
  }
}

console.log('')
console.log(`Файлов задач: ${stats.файлов}`)
if (DRY) {
  console.log('Пробный прогон — ничего не менялось.')
} else {
  console.log(`Перенесено задач: ${stats.перенесено}, пропущено: ${stats.пропущено}, ошибок: ${stats.ошибок}`)
  console.log(`Строк журнала: ${stats.журнала}, истории и результатов: ${stats.событий}, ключей действий: ${stats.ключей}`)
  console.log('Файлы оставлены на месте — убирать их отдельным решением, когда станет видно, что панель работает с базой.')
}
for (const p of проблемы) console.warn('  ⚠', p)
if (stats.ошибок) process.exit(1)
