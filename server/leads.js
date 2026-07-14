/**
 * CRM: Лиды (§3.6, docs/ARCH-goals-crm.md). Лид привязан к цели и ответственному аккаунту.
 * MVP: бэкенд-скелет CRUD. Хранение — JSON data/leads.json; путь через env LEADS_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const LEADS_FILE = process.env.LEADS_FILE || dataPath('leads.json')

/** Статусы лида (§3.6): холодный → ответил → горячий → целевое действие → закрыт. */
export const LEAD_STATUSES = ['cold', 'answered', 'hot', 'target', 'closed']

/** @param {object} input */
export function normalizeLead(input = {}) {
  const status = LEAD_STATUSES.includes(input.status) ? input.status : 'cold'
  return {
    goalId: input.goalId ? String(input.goalId) : null,
    accountId: input.accountId ? String(input.accountId) : null, // ответственный аккаунт
    peer: String(input.peer ?? '').trim(), // с кем диалог (username/id)
    status,
    result: String(input.result ?? ''),
    note: String(input.note ?? ''),
  }
}

/** @param {{ goalId?: string, status?: string, accountId?: string }} [filter] */
export async function listLeads(filter = {}) {
  const all = await readJson(LEADS_FILE, [])
  return all.filter((l) =>
    (!filter.goalId || l.goalId === filter.goalId) &&
    (!filter.status || l.status === filter.status) &&
    (!filter.accountId || l.accountId === filter.accountId),
  )
}

export async function createLead(input) {
  const clean = normalizeLead(input)
  if (!clean.peer) throw new Error('Укажите контакт лида (peer)')
  const all = await readJson(LEADS_FILE, [])
  const lead = {
    id: `lead_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    isHot: clean.status === 'hot',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(lead)
  await writeJson(LEADS_FILE, all)
  return lead
}

/** @param {string} id @param {object} patch */
export async function updateLead(id, patch = {}) {
  const all = await readJson(LEADS_FILE, [])
  const i = all.findIndex((l) => l.id === id)
  if (i === -1) return null
  const FIELDS = ['goalId', 'accountId', 'peer', 'status', 'result', 'note']
  for (const k of FIELDS) {
    if (patch[k] !== undefined) {
      if (k === 'status' && !LEAD_STATUSES.includes(patch[k])) continue
      all[i][k] = k === 'peer' ? String(patch[k]).trim() : (patch[k] === null ? null : String(patch[k]))
    }
  }
  all[i].isHot = all[i].status === 'hot'
  all[i].updatedAt = Date.now()
  await writeJson(LEADS_FILE, all)
  return all[i]
}

export async function deleteLead(id) {
  const all = await readJson(LEADS_FILE, [])
  const next = all.filter((l) => l.id !== id)
  if (next.length === all.length) return false
  await writeJson(LEADS_FILE, next)
  return true
}

/** Сводка по статусам (аналитика §3.6). @param {string} [goalId] */
export async function leadStats(goalId) {
  const leads = await listLeads(goalId ? { goalId } : {})
  const by = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]))
  for (const l of leads) by[l.status] = (by[l.status] || 0) + 1
  return { total: leads.length, byStatus: by }
}
