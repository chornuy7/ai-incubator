/**
 * Журнал действий модулей (LOG-002 / MR-121). Реализует docs/CONTRACT-action-log.md.
 *
 * Append-only: структурированный след КАЖДОГО действия бота в Telegram (пост, коммент,
 * реакция, чат, ЛС, вступление) — что за аккаунт, над каким объектом, по какой задаче,
 * когда. В отличие от аудита (действия человека над платформой) и task.logs (текст
 * воркера), этот журнал queryable: из него растут «История аккаунта» (MR-122) и аналитика.
 *
 * `buildActionEntry` — чистая нормализация (юнит-тестируется отдельно от I/O).
 * Хранилище: таблица `module_actions` в supabase-режиме, иначе файл data/module-actions.jsonl
 * (как audit-log — код и миграция не обязаны совпадать по времени).
 */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Типы действий (см. контракт §3). Всё, что не из списка, нормализуем к 'action'. */
export const ACTION_TYPES = ['post', 'comment', 'reaction', 'chat', 'dialog', 'dm', 'join', 'action']

const entryToRow = (e) => ({
  id: e.id, ts: e.ts, type: e.type, status: e.status,
  account_id: e.accountId || null, account_name: e.accountName || null,
  target: e.target || null, target_title: e.targetTitle || null,
  object_ref: e.objectRef || {}, value: e.value || {},
  module_key: e.moduleKey || null, task_id: e.taskId || null,
  launch_id: e.launchId || null, goal_id: e.goalId || null, initiator: e.initiator || null,
  audience: e.audience || {}, meta: e.meta || {}, created_at: e.createdAt,
})
const rowToEntry = (r) => ({
  id: r.id, ts: r.ts ? new Date(r.ts).toISOString() : '', type: r.type || 'action',
  status: r.status || 'sent', accountId: r.account_id || '', accountName: r.account_name || '',
  target: r.target || '', targetTitle: r.target_title || '',
  objectRef: r.object_ref || {}, value: r.value || {},
  moduleKey: r.module_key || '', taskId: r.task_id || '', launchId: r.launch_id || '',
  goalId: r.goal_id || '', initiator: r.initiator || '',
  audience: r.audience || {}, meta: r.meta || {},
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = process.env.ACTION_LOG_FILE || path.join(__dirname, 'data', 'module-actions.jsonl')
// Ретеншн: журнал действий на порядок объёмнее аудита — держим потолок и обрезаем старые.
const MAX_BYTES = Number(process.env.ACTION_LOG_MAX_BYTES) || 8 * 1024 * 1024
const KEEP_LINES = Number(process.env.ACTION_LOG_KEEP_LINES) || 50000

/**
 * Нормализовать действие к контрактному виду (§2). Чистая функция.
 * @param {{
 *   type?: string, status?: string, accountId?: string, accountName?: string,
 *   target?: string, targetTitle?: string, objectRef?: object, value?: object,
 *   moduleKey?: string, taskId?: string, launchId?: string, goalId?: string,
 *   initiator?: string, audience?: object, meta?: object, id?: string, ts?: string, createdAt?: string
 * }} input
 */
export function buildActionEntry(input = {}) {
  const type = ACTION_TYPES.includes(input.type) ? input.type : 'action'
  const ts = input.ts || new Date().toISOString()
  // id стабилен по задаче: не плодим коллизий при параллельных воркерах, но и не теряем
  // порядок — добавляем короткий случайный хвост.
  const id = input.id || `act_${input.taskId || 'x'}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`
  return {
    id,
    ts,
    type,
    status: input.status || 'sent',
    accountId: input.accountId || '',
    accountName: input.accountName || '',
    target: input.target || '',
    targetTitle: input.targetTitle || '',
    objectRef: input.objectRef || {},
    value: input.value || {},
    moduleKey: input.moduleKey || '',
    taskId: input.taskId || '',
    launchId: input.launchId || input.taskId || '',
    goalId: input.goalId || '',
    initiator: input.initiator || '',
    audience: input.audience || { repliesCount: 0, reactionsCount: 0, reactions: {}, replies: [], checkedAt: null },
    meta: input.meta || {},
    createdAt: input.createdAt || ts,
  }
}

/**
 * Записать действие в журнал. Best-effort и НЕ роняет действие: как recordTokens —
 * коммент/реакция уже отправлены, откатывать нельзя, поэтому сбой журналирования
 * только логируется. Возвращает нормализованную запись.
 * @param {Parameters<typeof buildActionEntry>[0]} input
 */
export async function recordAction(input) {
  const entry = buildActionEntry(input)
  try {
    const db = sb()
    if (db) {
      const { error } = await db.from('module_actions').insert(entryToRow(entry))
      if (!error) return entry
    }
    await fs.mkdir(path.dirname(FILE), { recursive: true })
    await fs.appendFile(FILE, JSON.stringify(entry) + '\n', 'utf8')
    try {
      const st = await fs.stat(FILE)
      if (st.size > MAX_BYTES) {
        const lines = (await fs.readFile(FILE, 'utf8')).split('\n').filter(Boolean)
        if (lines.length > KEEP_LINES) await fs.writeFile(FILE, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8')
      }
    } catch { /* ротация не критична */ }
  } catch (err) {
    console.warn(`[actionLog] запись действия не удалась: ${err instanceof Error ? err.message : err}`)
  }
  return entry
}

/**
 * Прочитать действия (новые сверху). Фильтры — по критериям «Истории аккаунта» (MR-122):
 * аккаунт, тип действия, группа/канал, период.
 * @param {{
 *   accountId?: string, type?: string, target?: string, taskId?: string, moduleKey?: string,
 *   since?: number, until?: number, limit?: number
 * }} [filter]
 */
export async function readActions(filter = {}) {
  const { accountId, type, target, taskId, moduleKey, since, until, limit = 500 } = filter
  const db = sb()
  if (db) {
    let q = db.from('module_actions').select('*').order('ts', { ascending: false })
    if (accountId) q = q.eq('account_id', accountId)
    if (type) q = q.eq('type', type)
    if (taskId) q = q.eq('task_id', taskId)
    if (moduleKey) q = q.eq('module_key', moduleKey)
    if (target) q = q.eq('target', target)
    if (since) q = q.gte('ts', new Date(Number(since)).toISOString())
    if (until) q = q.lte('ts', new Date(Number(until)).toISOString())
    q = q.limit(limit)
    const { data, error } = await q
    if (!error) return (data || []).map(rowToEntry)
  }
  let lines
  try { lines = (await fs.readFile(FILE, 'utf8')).split('\n').filter(Boolean) }
  catch { return [] }
  const out = []
  for (const l of lines) {
    try {
      const e = JSON.parse(l)
      if (accountId && e.accountId !== accountId) continue
      if (type && e.type !== type) continue
      if (taskId && e.taskId !== taskId) continue
      if (moduleKey && e.moduleKey !== moduleKey) continue
      if (target && e.target !== target) continue
      const t = Date.parse(e.ts) || 0
      if (since && t < Number(since)) continue
      if (until && t > Number(until)) continue
      out.push(e)
    } catch { /* skip broken line */ }
  }
  // Новые сверху.
  return out.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0)).slice(0, limit)
}
