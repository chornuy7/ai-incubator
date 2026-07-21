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
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'

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
  const group = { id: `grp_${crypto.randomUUID().slice(0, 8)}`, ...clean, createdAt: Date.now(), updatedAt: Date.now() }
  await mutateJson(GROUPS_FILE, (all) => { all.unshift(group); return all }, [])
  return group
}

export async function updateGroup(id, patch = {}) {
  let result = null
  await mutateJson(GROUPS_FILE, (all) => {
  const i = all.findIndex((g) => g.id === id)
  if (i === -1) return undefined
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    if (k === 'accountIds') all[i].accountIds = normIds(patch[k])
    else all[i][k] = String(patch[k]).trim()
  }
  if (!all[i].name) throw new Error('Название группы не может быть пустым')
  all[i].updatedAt = Date.now()
  result = all[i]
  return all
  }, [])
  return result
}

export async function deleteGroup(id) {
  let removed = false
  await mutateJson(GROUPS_FILE, (all) => {
    const next = all.filter((g) => g.id !== id)
    if (next.length === all.length) return undefined
    removed = true
    return next
  }, [])
  return removed
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
 *
 * Контракт значений — как во всём `roles.js`: строки `'allow'`/`'deny'`
 * (отсутствие ключа = «мнения нет», не запрет). Зеркало `src/shared/lib/access.ts`.
 *
 * ВАЖНО: после `mergePermissions` (объединение ролей — union) в правах остаются
 * ТОЛЬКО ключи `'allow'`, поэтому ветка точечного deny работает лишь для прав
 * одной сырой роли. Это следствие union-семантики, а не недосмотр.
 *
 * @param {Record<string, 'allow'|'deny'>} accountPerms accountId → allow/deny
 * @param {Record<string, 'allow'|'deny'>} groupPerms   groupId → allow/deny
 * @param {object[]} groups
 * @param {string} accountId
 */
export function isAccountAllowedViaGroups(accountPerms = {}, groupPerms = {}, groups = [], accountId) {
  if (accountPerms[accountId] === 'deny') return false // точечный запрет сильнее
  if (accountPerms[accountId] === 'allow') return true
  for (const g of Array.isArray(groups) ? groups : []) {
    if (groupPerms[g?.id] !== 'allow') continue
    if ((g.accountIds || []).includes(accountId)) return true
  }
  return false
}
