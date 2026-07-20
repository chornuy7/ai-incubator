/**
 * §12: группы (папки) аккаунтов — чтобы выдавать доступ роли на ГРУППУ, а не по
 * одному аккаунту, и выбирать аккаунты папкой при настройке кампании (§5).
 *
 * Важно: группа — отдельная сущность и сама держит список аккаунтов
 * (как закрепление в кампании). Поле в `accountsMeta.js` не заводим — это файл
 * соседней дорожки, и хранение «наоборот» позволяет не трогать его вовсе.
 *
 * Хранение — JSON `data/account-groups.json`; путь через env ACCOUNT_GROUPS_FILE.
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const GROUPS_FILE = process.env.ACCOUNT_GROUPS_FILE || dataPath('account-groups.json')

const FIELDS = ['name', 'accountIds', 'color', 'note']

const normIds = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))] : [])

/** Нормализовать вход в чистую группу. @param {object} input */
export function normalizeGroup(input = {}) {
  return {
    name: String(input.name ?? '').trim(),
    accountIds: normIds(input.accountIds),
    color: String(input.color ?? '').trim().slice(0, 20),
    note: String(input.note ?? '').slice(0, 300),
  }
}

export async function listGroups() {
  return readJson(GROUPS_FILE, [])
}

export async function getGroup(id) {
  const all = await readJson(GROUPS_FILE, [])
  return all.find((g) => g.id === id) || null
}

export async function createGroup(input) {
  const clean = normalizeGroup(input)
  if (!clean.name) throw new Error('Укажите название группы')
  const all = await readJson(GROUPS_FILE, [])
  const group = { id: `grp_${crypto.randomUUID().slice(0, 8)}`, ...clean, createdAt: Date.now(), updatedAt: Date.now() }
  all.unshift(group)
  await writeJson(GROUPS_FILE, all)
  return group
}

export async function updateGroup(id, patch = {}) {
  const all = await readJson(GROUPS_FILE, [])
  const i = all.findIndex((g) => g.id === id)
  if (i === -1) return null
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    if (k === 'accountIds') all[i].accountIds = normIds(patch[k])
    else all[i][k] = String(patch[k]).trim()
  }
  if (!all[i].name) throw new Error('Название группы не может быть пустым')
  all[i].updatedAt = Date.now()
  await writeJson(GROUPS_FILE, all)
  return all[i]
}

export async function deleteGroup(id) {
  const all = await readJson(GROUPS_FILE, [])
  const next = all.filter((g) => g.id !== id)
  if (next.length === all.length) return false
  await writeJson(GROUPS_FILE, next)
  return true
}

/**
 * §12: все аккаунты из перечисленных групп (без дублей). Чистая функция.
 * @param {object[]} groups @param {string[]} groupIds @returns {string[]}
 */
export function accountsOfGroups(groups = [], groupIds = []) {
  const want = new Set((groupIds || []).map(String))
  const out = new Set()
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!want.has(g?.id)) continue
    for (const id of g.accountIds || []) out.add(id)
  }
  return [...out]
}

/**
 * §12: в каких группах состоит аккаунт (для показа меток). Чистая функция.
 * @returns {Record<string, {id: string, name: string}[]>} accountId → группы
 */
export function groupsByAccount(groups = []) {
  /** @type {Record<string, {id: string, name: string}[]>} */
  const map = {}
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const id of g?.accountIds || []) {
      (map[id] ||= []).push({ id: g.id, name: g.name })
    }
  }
  return map
}

/**
 * §12: разрешён ли аккаунт роли — напрямую ИЛИ через разрешённую группу.
 * Прямой deny сильнее группового allow (точечный запрет важнее). Чистая функция.
 * @param {Record<string, boolean>} accountPerms accountId → allow/deny
 * @param {Record<string, boolean>} groupPerms   groupId → allow/deny
 * @param {object[]} groups
 * @param {string} accountId
 */
export function isAccountAllowedViaGroups(accountPerms = {}, groupPerms = {}, groups = [], accountId) {
  if (accountPerms[accountId] === false) return false // точечный запрет сильнее
  if (accountPerms[accountId] === true) return true
  for (const g of Array.isArray(groups) ? groups : []) {
    if (groupPerms[g?.id] !== true) continue
    if ((g.accountIds || []).includes(accountId)) return true
  }
  return false
}
