import crypto from 'crypto'
import { dataPath, readJson, writeJson } from '../lib/jsonStore.js'

const FILE = dataPath('automation/rules.json')

function newId() {
  return `au_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * @typedef {Object} AutomationSchedule
 * @property {'once'|'interval'|'daily'} type
 * @property {number} [at]              // epoch ms — для once
 * @property {number} [intervalMinutes] // для interval
 * @property {string} [time]            // 'HH:MM' — для daily
 */

/**
 * @typedef {Object} AutomationRule
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {string} moduleKey
 * @property {string[]} accountIds
 * @property {object} settings
 * @property {AutomationSchedule} schedule
 * @property {number|null} lastRun
 * @property {string|null} lastStatus
 * @property {string|null} lastTaskId
 * @property {number|null} nextRun
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** Вычислить следующий запуск. @param {AutomationRule} rule @param {number} [from] */
export function computeNextRun(rule, from = Date.now()) {
  const s = rule.schedule || {}
  if (!rule.enabled) return null
  if (s.type === 'once') {
    const at = Number(s.at || 0)
    if (!at) return null
    if (rule.lastRun && rule.lastRun >= at) return null
    return at
  }
  if (s.type === 'interval') {
    const stepMs = Math.max(1, Number(s.intervalMinutes || 60)) * 60_000
    const base = rule.lastRun || rule.createdAt || from
    let next = base + stepMs
    if (next < from) next = from
    return next
  }
  if (s.type === 'daily') {
    const [hh, mm] = String(s.time || '12:00').split(':').map((x) => Number(x) || 0)
    const d = new Date(from)
    d.setSeconds(0, 0)
    d.setHours(hh, mm, 0, 0)
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return null
}

export async function listRules() {
  const data = await readJson(FILE, { rules: [] })
  return Array.isArray(data?.rules) ? data.rules : []
}

async function saveRules(rules) {
  await writeJson(FILE, { rules, updatedAt: Date.now() })
}

function sanitizeSchedule(schedule) {
  const s = schedule || {}
  const type = ['once', 'interval', 'daily'].includes(s.type) ? s.type : 'interval'
  return {
    type,
    ...(s.at !== undefined ? { at: Number(s.at) || 0 } : {}),
    ...(s.intervalMinutes !== undefined ? { intervalMinutes: Math.max(1, Number(s.intervalMinutes) || 60) } : {}),
    ...(s.time !== undefined ? { time: String(s.time) } : {}),
  }
}

/** @param {Partial<AutomationRule>} input */
export async function createRule(input) {
  const rules = await listRules()
  const now = Date.now()
  const rule = /** @type {AutomationRule} */ ({
    id: newId(),
    name: String(input?.name || '').trim() || 'Правило автоматизации',
    enabled: input?.enabled !== false,
    moduleKey: String(input?.moduleKey || ''),
    accountIds: Array.isArray(input?.accountIds) ? input.accountIds : [],
    settings: input?.settings && typeof input.settings === 'object' ? input.settings : {},
    schedule: sanitizeSchedule(input?.schedule),
    lastRun: null,
    lastStatus: null,
    lastTaskId: null,
    nextRun: null,
    createdAt: now,
    updatedAt: now,
  })
  rule.nextRun = computeNextRun(rule, now)
  rules.unshift(rule)
  await saveRules(rules.slice(0, 200))
  return rule
}

/** @param {string} id @param {Partial<AutomationRule>} patch */
export async function updateRule(id, patch) {
  const rules = await listRules()
  const idx = rules.findIndex((r) => r.id === id)
  if (idx === -1) return null
  const cur = rules[idx]
  const next = {
    ...cur,
    ...(patch?.name !== undefined ? { name: String(patch.name).trim() || cur.name } : {}),
    ...(patch?.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
    ...(patch?.moduleKey !== undefined ? { moduleKey: String(patch.moduleKey) } : {}),
    ...(patch?.accountIds !== undefined ? { accountIds: Array.isArray(patch.accountIds) ? patch.accountIds : [] } : {}),
    ...(patch?.settings !== undefined ? { settings: patch.settings && typeof patch.settings === 'object' ? patch.settings : {} } : {}),
    ...(patch?.schedule !== undefined ? { schedule: sanitizeSchedule(patch.schedule) } : {}),
    ...(patch?.lastRun !== undefined ? { lastRun: patch.lastRun } : {}),
    ...(patch?.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
    ...(patch?.lastTaskId !== undefined ? { lastTaskId: patch.lastTaskId } : {}),
    updatedAt: Date.now(),
  }
  next.nextRun = computeNextRun(next)
  rules[idx] = next
  await saveRules(rules)
  return next
}

/** @param {string} id */
export async function deleteRule(id) {
  const rules = await listRules()
  const next = rules.filter((r) => r.id !== id)
  if (next.length === rules.length) return false
  await saveRules(next)
  return true
}

/** Массовое сохранение (используется планировщиком). @param {AutomationRule[]} rules */
export async function replaceRules(rules) {
  await saveRules(rules)
}
