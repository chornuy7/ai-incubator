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
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sbC() { return supabaseEnabled() ? getSupabase() : null }
const rowToCampaign = (r) => ({ id: r.id, name: r.name, goalId: r.goal_id || null, modules: r.modules || [], ...(r.data || {}), createdAt: r.created_at ? new Date(r.created_at).getTime() : 0, updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0 })
const campaignToRow = (c) => {
  const { id, name, goalId, modules, createdAt, updatedAt, ...data } = c
  return { id, name, goal_id: goalId || null, modules: modules || [], data, created_at: new Date(createdAt || Date.now()).toISOString(), updated_at: new Date(updatedAt || Date.now()).toISOString() }
}

const CAMPAIGNS_FILE = process.env.CAMPAIGNS_FILE || dataPath('campaigns.json')

/** Статусы кампании. `draft` — настраивается, `active` — работает, `paused`, `done`. */
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'done']

/** Поля, которые можно задавать/менять. */
// §0: `modules` — кампания ведёт НЕСКОЛЬКО модулей (звонок 22.07). §9.0: `targets` —
// у кампании СВОИ целевые каналы (раньше брались из цели, из-за чего рядом жил отдельный
// «разовый запускатор» и на странице было две сущности «кампания», тест 1.2).
const FIELDS = ['name', 'goalId', 'moduleKey', 'modules', 'moduleAgents', 'moduleSettings', 'moduleTargets', 'settings', 'accountIds', 'pinned', 'status', 'chat', 'targets']

const normIds = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))] : [])

/** Целевые каналы: без @, без пробелов, нижний регистр, без дублей (см. normalizeCampaign). */
function normTargets(v) {
  return [...new Set((Array.isArray(v) ? v : [])
    .map((x) => String(x || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
}

/** Модуль-«догоняющий»: ведёт переписку с теми, кто ответил на основной модуль. */
export const CHAT_MODULE = 'neuro-dialogs'

/**
 * Догоняющий чатинг кампании (§9): основной модуль приводит людей (рассылка/комментинг),
 * а чатинг ведёт с ответившими переписку к цели. Выключен по умолчанию — чтобы не менять
 * поведение существующих кампаний.
 * @param {*} v
 */
function normChat(v) {
  const c = v && typeof v === 'object' ? v : {}
  return {
    enabled: c.enabled === true,
    settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
  }
}

/** Сколько сообщений подряд можно дожимать одного человека, если он написал сам. */
export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

/** Разумные границы дедлайна — те же, что были у цели. */
export const DEADLINE_MIN_YEAR = 2000
export const DEADLINE_MAX_YEAR = new Date().getFullYear() + 20

/**
 * Дедлайн кампании — строго 'YYYY-MM-DD' в разумных годах, иначе null.
 * Проверка жёсткая не от вредности: раньше в базу проходил год 123123 (опечатка),
 * на карточке рисовалось «до 24.07.123123», и срок не наступал никогда.
 * @param {*} v
 */
function normDeadline(v) {
  if (!v) return null
  const s = String(v).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  if (year < DEADLINE_MIN_YEAR || year > DEADLINE_MAX_YEAR) return null
  const d = new Date(`${s}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  // Отсекаем несуществующие даты вроде 2026-02-31 — Date их «доворачивает» на март.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null
  return s
}

/**
 * Дожим живёт в КАМПАНИИ, а не в агенте (решение звонка 24.07).
 *
 * Агент — это манера речи; «дожимать или отпустить» — решение о ходе работы, а его
 * принимает тот, кто знает цель, этап и пул. Одного агента ставят и в кампанию,
 * где дожимают до последнего, и в ту, где пишут один раз.
 * @param {*} v
 */
function normFollowUp(v) {
  if (!v || typeof v !== 'object') return { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' }
  const n = Math.floor(Number(v.limit) || 0)
  return {
    enabled: !!v.enabled,
    limit: n > 0 ? Math.min(n, FOLLOW_UP_MAX) : FOLLOW_UP_DEFAULT,
    instructions: String(v.instructions ?? '').slice(0, 2000),
  }
}

/** Нормализовать вход в чистую кампанию. @param {object} input */
/**
 * Список модулей кампании: без дублей, пустые отброшены. Для кампаний, созданных
 * до появления поля, берём одиночный `moduleKey` — миграция не нужна.
 * @param {*} list @param {*} single
 */
function normModules(list, single) {
  const arr = Array.isArray(list) ? list : []
  const keys = [...arr, single].map((x) => String(x ?? '').trim()).filter(Boolean)
  return [...new Set(keys)]
}

/**
 * SPEC §2.6 (A3.2): какой АГЕНТ ведёт каждый модуль кампании. Держим отдельной картой
 * `moduleKey → agentId`, а не переводим `modules` в объекты: на строковый массив
 * опираются фильтры (`c.modules.includes(...)`), фронт и старые кампании — переделка
 * потребовала бы миграции ради того же результата.
 * Ключи, которых нет среди модулей кампании, отбрасываем: иначе в данных копился бы
 * мусор от переключений в форме.
 * @param {*} map @param {string[]} modules
 */
function normModuleAgents(map, modules) {
  const src = map && typeof map === 'object' ? map : {}
  const out = {}
  for (const k of modules) {
    const v = String(src[k] ?? '').trim()
    if (v) out[k] = v
  }
  return out
}

/**
 * Настройки (пресет) КАЖДОГО модуля кампании: `moduleKey → settings`. Раньше пресет был
 * один на кампанию (первый модуль) — второй модуль запускался с настройками по умолчанию,
 * даже если для него сохранён свой пресет. Держим только ключи выбранных модулей — мусор
 * от переключений в форме не копится.
 * @param {*} map @param {string[]} modules
 */
function normModuleSettings(map, modules) {
  const src = map && typeof map === 'object' ? map : {}
  const out = {}
  for (const k of modules) {
    const v = src[k]
    if (v && typeof v === 'object' && Object.keys(v).length) out[k] = v
  }
  return out
}

/**
 * Свои цели у отдельного модуля: `moduleKey → [цели]`. Нужно рассылке — её «цель» это
 * получатель (номер/юзернейм), а не канал, поэтому мешать её в общие целевые каналы
 * кампании нельзя. Номера НЕ приводим к нижнему регистру и не режем @ — рассылка сама
 * разбирает номер vs юзернейм (`classifyMailingTargets`); порча формата номера сломала бы разбор.
 * @param {*} map @param {string[]} modules
 */
function normModuleTargets(map, modules) {
  const src = map && typeof map === 'object' ? map : {}
  const out = {}
  for (const k of modules) {
    const arr = Array.isArray(src[k]) ? src[k] : []
    const clean = [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))]
    if (clean.length) out[k] = clean
  }
  return out
}

export function normalizeCampaign(input = {}) {
  const status = CAMPAIGN_STATUSES.includes(input.status) ? input.status : 'draft'
  const modules = normModules(input.modules, input.moduleKey)
  return {
    name: String(input.name ?? '').trim(),
    goalId: input.goalId ? String(input.goalId) : null,
    // §0: модули кампании. Их может быть несколько и работать они должны ВМЕСТЕ —
    // комментинг приводит людей, рассылка пишет им, чатинг ловит ответы. Раньше
    // кампания держала ровно один модуль, и «комментинг + рассылка» собрать было нельзя,
    // хотя сам запуск (`launchCampaign`) несколько модулей принимал всегда.
    modules,
    moduleAgents: normModuleAgents(input.moduleAgents, modules),
    // Пресет КАЖДОГО модуля отдельно (раньше — один на кампанию, второй модуль шёл с дефолтом).
    moduleSettings: normModuleSettings(input.moduleSettings, modules),
    // Свои цели у модуля (рассылка: получатели-номера/юзернеймы, а не общие каналы).
    moduleTargets: normModuleTargets(input.moduleTargets, modules),
    // Первый модуль дублируем в moduleKey: на него смотрят фильтры и старые кампании.
    moduleKey: modules[0] || '',
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {}, // общий пресет (совместимость)
    accountIds: normIds(input.accountIds),
    // Нормализуем как цели папок: без @, без пробелов, нижний регистр, без дублей —
    // иначе @Crypto и @crypto дали бы двойную обработку одним аккаунтом (ср. 11.7-d).
    targets: normTargets(input.targets),
    pinned: input.pinned !== false, // по умолчанию аккаунты закрепляются (выходят из общего пула)
    status,
    chat: normChat(input.chat), // §9: опциональный догоняющий чатинг
    followUp: normFollowUp(input.followUp), // дожим — решение кампании, не агента
    // Дедлайн переехал из цели (24.07): срок — свойство ЭТАПА работы. Цель «200
    // переходов» бессрочна сама по себе; это кампания обязана уложиться к дате.
    deadline: normDeadline(input.deadline),
  }
}

export async function listCampaigns(filter = {}) {
  const db = sbC()
  const all = db
    ? ((await db.from('campaigns').select('*').order('created_at', { ascending: false })).data || []).map(rowToCampaign)
    : await readJson(CAMPAIGNS_FILE, [])
  // Кампании, созданные до многомодульности, отдаём с `modules` — иначе фронту
  // пришлось бы проверять оба поля в каждом месте.
  return all
    .map((c) => ({ ...c, modules: normModules(c.modules, c.moduleKey) }))
    .filter((c) =>
      (!filter.goalId || c.goalId === filter.goalId) &&
      (!filter.status || c.status === filter.status) &&
      (!filter.moduleKey || c.modules.includes(filter.moduleKey)),
    )
}

export async function getCampaign(id) {
  const db = sbC()
  if (db) {
    const { data } = await db.from('campaigns').select('*').eq('id', id).maybeSingle()
    return data ? rowToCampaign(data) : null
  }
  const all = await readJson(CAMPAIGNS_FILE, [])
  return all.find((c) => c.id === id) || null
}

/** Применить patch к кампании на месте — общая логика для файла и БД. @returns {campaign} */
function applyCampaignPatch(target, patch) {
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    if (k === 'accountIds') target.accountIds = normIds(patch[k])
    else if (k === 'modules') target.modules = normModules(patch[k], patch.moduleKey ?? target.moduleKey)
    else if (k === 'moduleAgents') target.moduleAgents = normModuleAgents(patch[k], target.modules)
    else if (k === 'moduleSettings') target.moduleSettings = normModuleSettings(patch[k], target.modules)
    else if (k === 'moduleTargets') target.moduleTargets = normModuleTargets(patch[k], target.modules)
    else if (k === 'targets') target.targets = normTargets(patch[k])
    else if (k === 'settings') target.settings = patch[k] && typeof patch[k] === 'object' ? patch[k] : target.settings
    else if (k === 'pinned') target.pinned = patch[k] !== false
    else if (k === 'status') { if (CAMPAIGN_STATUSES.includes(patch[k])) target.status = patch[k] }
    else if (k === 'goalId') target.goalId = patch[k] ? String(patch[k]) : null
    else if (k === 'chat') target.chat = normChat(patch[k])
    else target[k] = String(patch[k]).trim()
  }
  if (!target.name) throw new Error('Название кампании не может быть пустым')
  if (!target.modules?.length && !target.moduleKey) throw new Error('У кампании должен быть модуль')
  target.updatedAt = Date.now()
  return target
}

/** @param {object} input @throws если нет имени или модуля */
export async function createCampaign(input) {
  const clean = normalizeCampaign(input)
  if (!clean.name) throw new Error('Укажите название кампании')
  if (!clean.modules.length) throw new Error('Кампания должна настраивать модуль — выберите хотя бы один')
  const campaign = {
    id: `cmp_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const db = sbC()
  if (db) { await db.from('campaigns').insert(campaignToRow(campaign)); return campaign }
  await mutateJson(CAMPAIGNS_FILE, (all) => { all.unshift(campaign); return all }, [])
  return campaign
}

/** @param {string} id @param {object} patch */
export async function updateCampaign(id, patch = {}) {
  const db = sbC()
  if (db) {
    const cur = await getCampaign(id)
    if (!cur) return null
    const updated = applyCampaignPatch(cur, patch)
    await db.from('campaigns').update(campaignToRow(updated)).eq('id', id)
    return updated
  }
  let result = null
  await mutateJson(CAMPAIGNS_FILE, (all) => {
    const i = all.findIndex((c) => c.id === id)
    if (i === -1) return undefined
    result = applyCampaignPatch(all[i], patch)
    return all
  }, [])
  return result
}

export async function deleteCampaign(id) {
  const db = sbC()
  if (db) {
    const { data } = await db.from('campaigns').delete().eq('id', id).select('id')
    return !!(data && data.length)
  }
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
