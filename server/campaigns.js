/**
 * Сущность «Кампания» (§5, §0) — исполнение под целью: закреплённые аккаунты +
 * НАСТРОЕННЫЙ модуль (пресет). Раньше кампании как сущности не было: `lib/campaign.js`
 * это только планировщик запуска. Здесь — хранилище и CRUD.
 *
 * Решения (предложены в docs/questions-crosslane-2026-07-18.md, возражений не поступило):
 *  - кампания настраивает РОВНО ОДИН модуль (§0: «закреплённые аккаунты + настроенный модуль»);
 *  - закрепление аккаунтов персистентно (переживает рестарт) — отдельный слой поверх
 *    пер-задачных lease из `lib/accountLocks.js`;
 *  - кампания принадлежит цели (goalId).
 *
 * Хранение — JSON `data/campaigns.json`; путь через env CAMPAIGNS_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'

const CAMPAIGNS_FILE = process.env.CAMPAIGNS_FILE || dataPath('campaigns.json')

/** Статусы кампании. `draft` — настраивается, `active` — работает, `paused`, `done`. */
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'done']

/** Поля, которые можно задавать/менять. */
const FIELDS = ['name', 'goalId', 'moduleKey', 'settings', 'accountIds', 'pinned', 'status']

const normIds = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))] : [])

/** Нормализовать вход в чистую кампанию. @param {object} input */
export function normalizeCampaign(input = {}) {
  const status = CAMPAIGN_STATUSES.includes(input.status) ? input.status : 'draft'
  return {
    name: String(input.name ?? '').trim(),
    goalId: input.goalId ? String(input.goalId) : null,
    moduleKey: String(input.moduleKey ?? '').trim(), // ровно один модуль (§0)
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {}, // пресет модуля
    accountIds: normIds(input.accountIds),
    pinned: input.pinned !== false, // по умолчанию аккаунты закрепляются (выходят из общего пула)
    status,
  }
}

export async function listCampaigns(filter = {}) {
  const all = await readJson(CAMPAIGNS_FILE, [])
  return all.filter((c) =>
    (!filter.goalId || c.goalId === filter.goalId) &&
    (!filter.status || c.status === filter.status) &&
    (!filter.moduleKey || c.moduleKey === filter.moduleKey),
  )
}

export async function getCampaign(id) {
  const all = await readJson(CAMPAIGNS_FILE, [])
  return all.find((c) => c.id === id) || null
}

/** @param {object} input @throws если нет имени или модуля */
export async function createCampaign(input) {
  const clean = normalizeCampaign(input)
  if (!clean.name) throw new Error('Укажите название кампании')
  if (!clean.moduleKey) throw new Error('Кампания должна настраивать модуль — выберите модуль')
  const campaign = {
    id: `cmp_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await mutateJson(CAMPAIGNS_FILE, (all) => { all.unshift(campaign); return all }, [])
  return campaign
}

/** @param {string} id @param {object} patch */
export async function updateCampaign(id, patch = {}) {
  let result = null
  await mutateJson(CAMPAIGNS_FILE, (all) => {
  const i = all.findIndex((c) => c.id === id)
  if (i === -1) return undefined
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    if (k === 'accountIds') all[i].accountIds = normIds(patch[k])
    else if (k === 'settings') all[i].settings = patch[k] && typeof patch[k] === 'object' ? patch[k] : all[i].settings
    else if (k === 'pinned') all[i].pinned = patch[k] !== false
    else if (k === 'status') { if (CAMPAIGN_STATUSES.includes(patch[k])) all[i].status = patch[k] }
    else if (k === 'goalId') all[i].goalId = patch[k] ? String(patch[k]) : null
    else all[i][k] = String(patch[k]).trim()
  }
  if (!all[i].name) throw new Error('Название кампании не может быть пустым')
  if (!all[i].moduleKey) throw new Error('У кампании должен быть модуль')
  all[i].updatedAt = Date.now()
  result = all[i]
  return all
  }, [])
  return result
}

export async function deleteCampaign(id) {
  let removed = false
  await mutateJson(CAMPAIGNS_FILE, (all) => {
    const next = all.filter((c) => c.id !== id)
    if (next.length === all.length) return undefined
    removed = true
    return next
  }, [])
  return removed
}

/**
 * §1/§5: карта «аккаунт → кампания, которая его закрепила». Чистая функция.
 * Закреплёнными считаем аккаунты кампаний с `pinned` и не завершённых (`done` отпускает).
 * @param {object[]} campaigns @returns {Record<string, {campaignId: string, name: string}>}
 */
export function pinnedAccountMap(campaigns = []) {
  /** @type {Record<string, {campaignId: string, name: string}>} */
  const map = {}
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    if (!c?.pinned || c.status === 'done') continue
    for (const id of c.accountIds || []) {
      if (!map[id]) map[id] = { campaignId: c.id, name: c.name }
    }
  }
  return map
}

/**
 * §5: свободен ли аккаунт (не закреплён другой кампанией). Чистая.
 * @param {Record<string, {campaignId: string}>} pinMap @param {string} accountId @param {string} [selfCampaignId]
 */
export function isAccountFree(pinMap, accountId, selfCampaignId) {
  const pin = pinMap?.[accountId]
  return !pin || pin.campaignId === selfCampaignId
}

/**
 * §5: аккаунты, закреплённые ЧУЖИМИ кампаниями (для guard при сохранении). Чистая.
 * @returns {string[]} список id занятых
 */
export function conflictingAccounts(pinMap, accountIds = [], selfCampaignId) {
  return accountIds.filter((id) => !isAccountFree(pinMap, id, selfCampaignId))
}
