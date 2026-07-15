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

/** Модули, которые ВЕДУТ диалог — им «горячий лид» на аккаунте не мешает (это их работа). */
export const DIALOG_MODULES = new Set(['neuro-chatting', 'neuro-dialogs'])

/** Есть ли у аккаунта активный горячий лид (диалог в разгаре). Чистая функция. @param {object[]} leads @param {string} accountId */
export function hasActiveHotLead(leads, accountId) {
  return (Array.isArray(leads) ? leads : []).some((l) => l.accountId === accountId && l.status === 'hot')
}

/**
 * Guard «горячий лид» (§3.3/§4): аккаунт с горячим лидом нельзя забирать в НЕ-диалоговый
 * модуль — диалог должен продолжаться. Возвращает строку-ошибку или null. Не бросает.
 * @param {string[]} accountIds @param {string} moduleKey
 */
export async function assertNoHotLeadConflict(accountIds, moduleKey) {
  if (!accountIds?.length || DIALOG_MODULES.has(moduleKey)) return null
  const leads = await readJson(LEADS_FILE, [])
  const blocked = accountIds.filter((id) => hasActiveHotLead(leads, id)).map((id) => String(id).slice(-6))
  if (!blocked.length) return null
  return `Профили ведут горячий лид — их нельзя забирать в другой модуль (диалог продолжается): ${blocked.join(', ')}.`
}

/** «Активный диалог» — лид в работе (не целевое действие и не закрыт). §3.6 */
export const ACTIVE_LEAD_STATUSES = new Set(['cold', 'answered', 'hot'])

/** Приоритет лида для обработки: ответивший/горячий — выше. Чистая функция. */
export function leadPriority(status) {
  return { hot: 4, answered: 3, target: 2, cold: 1, closed: 0 }[status] ?? 1
}

/** Сортировка лидов по приоритету (ответившему — приоритет, §3.6). Чистая, не мутирует. */
export function sortLeadsByPriority(leads = []) {
  return [...leads].sort((a, b) => leadPriority(b.status) - leadPriority(a.status) || (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** Сколько активных диалогов ведёт аккаунт. Чистая. @param {object[]} leads @param {string} accountId */
export function activeLeadCount(leads, accountId) {
  return (Array.isArray(leads) ? leads : []).filter((l) => l.accountId === accountId && ACTIVE_LEAD_STATUSES.has(l.status)).length
}

/**
 * Guard лимита активных диалогов (§3.6): нельзя грузить аккаунт в диалоговый модуль сверх
 * лимита активных лидов. limit<=0 — без ограничения. Возвращает строку-ошибку или null.
 * @param {string[]} accountIds @param {string} moduleKey @param {number} limit
 */
export async function assertActiveDialogLimit(accountIds, moduleKey, limit) {
  const lim = Number(limit) || 0
  if (!accountIds?.length || lim <= 0 || !DIALOG_MODULES.has(moduleKey)) return null
  const leads = await readJson(LEADS_FILE, [])
  const over = accountIds
    .map((id) => ({ id, n: activeLeadCount(leads, id) }))
    .filter((x) => x.n >= lim)
    .map((x) => `${String(x.id).slice(-6)} (${x.n})`)
  if (!over.length) return null
  return `Превышен лимит активных диалогов (${lim}) у профилей: ${over.join(', ')}. Закройте часть лидов или поднимите лимит.`
}

/** Сводка по статусам (аналитика §3.6). @param {string} [goalId] */
export async function leadStats(goalId) {
  const leads = await listLeads(goalId ? { goalId } : {})
  const by = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]))
  for (const l of leads) by[l.status] = (by[l.status] || 0) + 1
  return { total: leads.length, byStatus: by }
}
