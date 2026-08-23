/**
 * Разовый перенос журнала действий из файла в базу.
 *
 * Код пишет в module_actions, а если таблицы нет — безопасно падает на файл
 * data/module-actions.jsonl (так задумано: выкат кода и применение миграции не обязаны
 * совпадать). Пока миграцию не применили, история копилась в файле — забрать её оттуда
 * надо один раз, иначе она останется вне базы и не попадёт ни в один отчёт.
 *
 * Идемпотентен: id совпадают, повторный запуск ничего не задваивает. Файл не трогаем —
 * откат должен быть возможен.
 *
 *   node --env-file=.env scripts/migrate-actions-to-db.mjs          # показать план
 *   node --env-file=.env scripts/migrate-actions-to-db.mjs --apply  # выполнить
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getSupabase, supabaseEnabled } from '../server/lib/supabase.js'

const APPLY = process.argv.includes('--apply')
if (!supabaseEnabled()) { console.error('Нужна база: задайте SUPABASE_URL и ключ.'); process.exit(1) }
const db = getSupabase()

const FILE = process.env.ACTION_LOG_FILE || path.join(process.cwd(), 'server', 'data', 'module-actions.jsonl')
let raw = ''
try { raw = await fs.readFile(FILE, 'utf8') } catch { console.log('Файла журнала нет — переносить нечего.'); process.exit(0) }

const rows = []
for (const line of raw.split('\n')) {
  const s = line.trim(); if (!s) continue
  try { rows.push(JSON.parse(s)) } catch { /* битая строка — пропускаем, а не роняем перенос */ }
}
console.log(`В файле записей: ${rows.length}`)
if (!rows.length) process.exit(0)

const toRow = (e) => ({
  id: e.id, ts: e.ts, type: e.type || 'action', status: e.status || 'sent',
  account_id: e.accountId || null, account_name: e.accountName || null,
  target: e.target || null, target_title: e.targetTitle || null,
  object_ref: e.objectRef || {}, value: e.value || {},
  module_key: e.moduleKey || null, task_id: e.taskId || null,
  launch_id: e.launchId || null, goal_id: e.goalId || null, initiator: e.initiator || null,
  audience: e.audience || {}, meta: e.meta || {}, created_at: e.createdAt || e.ts,
})

const probe = await db.from('module_actions').select('id').limit(1)
if (probe.error) { console.error(`Таблицы нет: ${probe.error.message}\nСначала примените supabase/migrations/2026-08-18-module-actions.sql`); process.exit(1) }

for (const r of rows.slice(0, 5)) console.log(`  ${String(r.ts).slice(0, 16)}  ${r.type}/${r.status}  ${r.accountName || r.accountId || '—'}`)
if (rows.length > 5) console.log(`  … ещё ${rows.length - 5}`)

if (!APPLY) { console.log('\nЭто ПЛАН. Запустите с --apply, чтобы выполнить.'); process.exit(0) }

const { error } = await db.from('module_actions').upsert(rows.map(toRow), { onConflict: 'id' })
if (error) { console.error('Не перенеслось:', error.message); process.exit(1) }

const { count } = await db.from('module_actions').select('*', { count: 'exact', head: true })
console.log(`\nПеренесено. В базе записей: ${count}`)
console.log('Файл оставлен на месте — на случай отката.')
