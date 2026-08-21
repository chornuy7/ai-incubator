/**
 * CRM: Лиды (§3.6, docs/ARCH-goals-crm.md). Лид привязан к цели и ответственному аккаунту.
 * MVP: бэкенд-скелет CRUD. Хранение — JSON data/leads.json; путь через env LEADS_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { insertWithOwner, updateWithOwner, ownerOf } from './lib/ownerColumn.js'

function sbL() { return supabaseEnabled() ? getSupabase() : null }
const rowToLead = (r) => ({
  userId: ownerOf(r) || undefined,
  id: r.id, goalId: r.goal_id || null, campaignId: r.campaign_id || null, taskId: r.task_id || null, accountId: r.account_id || null,
  peer: r.peer || '', status: r.status || 'cold', isHot: !!r.is_hot, result: r.result || '', note: r.note || '',
  followUps: Number(r.followups) || 0,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0, updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
})
const leadToRow = (l) => ({
  id: l.id, goal_id: l.goalId || null, campaign_id: l.campaignId || null, task_id: l.taskId || null, account_id: l.accountId || null,
  peer: l.peer || '', status: l.status || 'cold', is_hot: !!l.isHot, result: l.result || '', note: l.note || '',
  followups: Number(l.followUps) || 0,
  // §11.3: чей лид — колонка user_id (FK на юзера).
  user_id: l.userId || null,
  created_at: new Date(l.createdAt || Date.now()).toISOString(), updated_at: new Date(l.updatedAt || Date.now()).toISOString(),
})

const LEADS_FILE = process.env.LEADS_FILE || dataPath('leads.json')

/**
 * Статусы лида — воронка прогрева (правки созвона 17.07, §9):
 * холодный → только написал (первое сообщение) → прогретый → заинтересованный → горячий,
 * плюс терминальные: целевое действие и закрыт. «Горячий» = мгновенный алерт менеджеру.
 */
export const LEAD_STATUSES = ['cold', 'contacted', 'warm', 'interested', 'hot', 'target', 'closed']

/** Легаси-алиасы старой воронки → новая (чтобы не потерять существующие данные). */
const LEGACY_STATUS = { answered: 'warm' }

/** Нормализация статуса: легаси-алиас, затем валидация; неизвестный → cold. */
export function mapLeadStatus(s) {
  const mapped = LEGACY_STATUS[s] || s
  return LEAD_STATUSES.includes(mapped) ? mapped : 'cold'
}

/** @param {object} input */
export function normalizeLead(input = {}) {
  const status = mapLeadStatus(input.status)
  return {
    /*
     * Владелец лида. Аудит 21.08: в файловом хранилище его не было ВООБЩЕ — колонка
     * `user_id` в базе есть с §11.3, но нормализация её не переносила, а значит на
     * запись владелец не доезжал никогда. Из-за этого вся CRM платформы отдавалась
     * любому вошедшему: контакт человека, статус, заметки, ответственный аккаунт.
     * Отфильтровать «своё» было буквально нечем.
     */
    userId: input.userId ? String(input.userId) : null,
    goalId: input.goalId ? String(input.goalId) : null,
    // Кампания, которая привела лида и ведёт его по воронке (24.07): статусы в CRM
    // проставляет она, поэтому лид должен помнить свою кампанию — для отчёта и фильтра.
    campaignId: input.campaignId ? String(input.campaignId) : null,
    // Конкретная задача-прогон, приведшая лида (31.07): «откуда пришёл» по каждой задаче
    // отдельно. Кампания может породить несколько задач — id кампании этого не различает.
    taskId: input.taskId ? String(input.taskId) : null,
    accountId: input.accountId ? String(input.accountId) : null, // ответственный аккаунт
    peer: String(input.peer ?? '').trim(), // с кем диалог (username/id)
    status,
    result: String(input.result ?? ''),
    note: String(input.note ?? ''),
    // Сколько раз человека дожимали — писали после того, как диалог был закрыт,
    // потому что он написал сам. Считаем отдельно от обычной воронки: дожатый лид
    // прошёл другой путь, и мерить его вместе с остальными — не понимать, что сработало.
    followUps: Math.max(0, Math.floor(Number(input.followUps) || 0)),
  }
}

/** @param {{ goalId?: string, status?: string, accountId?: string, userId?: string }} [filter] */
export async function listLeads(filter = {}) {
  const db = sbL()
  const all = db
    ? ((await db.from('leads').select('*').order('created_at', { ascending: false })).data || []).map(rowToLead)
    : await readJson(LEADS_FILE, [])
  return all.filter((l) =>
    (!filter.userId || String(l.userId || '') === String(filter.userId)) &&
    (!filter.goalId || l.goalId === filter.goalId) &&
    (!filter.campaignId || l.campaignId === filter.campaignId) &&
    (!filter.taskId || l.taskId === filter.taskId) &&
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
  const db = sbL()
  if (db) { await insertWithOwner(db, 'leads', leadToRow(lead)); return lead }
  all.unshift(lead)
  await writeJson(LEADS_FILE, all)
  return lead
}

/**
 * Закрепить лида за клиентом — только для разовой атрибуции старых записей
 * (`server/scripts/backfillOwners.mjs`).
 *
 * Отдельно от `updateLead` намеренно: обычная правка владельца НЕ меняет, иначе чужого
 * лида можно было бы переписать на себя обычным PUT. И только если владельца ещё нет:
 * переатрибуция существующего — это уже передача данных между клиентами, такое решается
 * не скриптом.
 *
 * @param {string} id @param {string} userId @returns {Promise<boolean>} true = закрепили
 */
export async function assignLeadOwner(id, userId) {
  if (!userId) return false
  const db = sbL()
  if (db) {
    const { data } = await db.from('leads').select('*').eq('id', id).maybeSingle()
    if (!data) return false
    const lead = rowToLead(data)
    if (lead.userId) return false
    await updateWithOwner(db, 'leads', leadToRow({ ...lead, userId }), 'id', id)
    return true
  }
  let ok = false
  await mutateJson(LEADS_FILE, (all) => {
    const i = all.findIndex((l) => l.id === id)
    if (i === -1 || all[i].userId) return all
    all[i].userId = String(userId)
    ok = true
    return all
  }, [])
  return ok
}

/** @param {string} id @param {object} patch */
function applyLeadPatch(target, patch) {
  const FIELDS = ['goalId', 'campaignId', 'taskId', 'accountId', 'peer', 'status', 'result', 'note', 'followUps']
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    if (k === 'status') {
      const mapped = LEGACY_STATUS[patch[k]] || patch[k]
      if (LEAD_STATUSES.includes(mapped)) target.status = mapped
      continue
    }
    if (k === 'followUps') { target.followUps = Math.max(0, Math.floor(Number(patch[k]) || 0)); continue }
    target[k] = k === 'peer' ? String(patch[k]).trim() : (patch[k] === null ? null : String(patch[k]))
  }
  target.isHot = target.status === 'hot'
  target.updatedAt = Date.now()
  return target
}

/** @param {string} id @param {object} patch */
export async function updateLead(id, patch = {}) {
  const db = sbL()
  if (db) {
    const { data } = await db.from('leads').select('*').eq('id', id).maybeSingle()
    if (!data) return null
    const updated = applyLeadPatch(rowToLead(data), patch)
    await updateWithOwner(db, 'leads', leadToRow(updated), 'id', id)
    return updated
  }
  const all = await readJson(LEADS_FILE, [])
  const i = all.findIndex((l) => l.id === id)
  if (i === -1) return null
  applyLeadPatch(all[i], patch)
  await writeJson(LEADS_FILE, all)
  return all[i]
}

export async function deleteLead(id) {
  const db = sbL()
  if (db) {
    const { data } = await db.from('leads').delete().eq('id', id).select('id')
    return !!(data && data.length)
  }
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
// Активные (в работе) статусы воронки — не терминальные target/closed.
export const ACTIVE_LEAD_STATUSES = new Set(['cold', 'contacted', 'warm', 'interested', 'hot'])

/**
 * Приоритет лида для обработки: чем горячее по воронке — тем выше. Чистая функция.
 * hot > interested > warm > contacted > cold; target (цель достигнута) и closed — низкий.
 */
export function leadPriority(status) {
  return { hot: 6, interested: 5, warm: 4, contacted: 3, target: 2, cold: 1, closed: 0 }[status] ?? 1
}

/** Сортировка лидов по приоритету (ответившему — приоритет, §3.6). Чистая, не мутирует. */
export function sortLeadsByPriority(leads = []) {
  return [...leads].sort((a, b) => leadPriority(b.status) - leadPriority(a.status) || (b.updatedAt || 0) - (a.updatedAt || 0))
}

const normPeer = (x) => String(x ?? '').trim().toLowerCase().replace(/^@/, '')

/**
 * «Ячейка» лида в CRM. Решение 24–31.07: цель — это ЧИСТЫЙ СЧЁТЧИК, а воронкой владеет
 * КАМПАНИЯ, поэтому лид уникален в пределах кампании (один и тот же человек в двух
 * кампаниях — два лида, каждый со своей воронкой). Без кампании (ручной ввод, старые
 * прогоны) откатываемся на цель, а совсем без обоих — на самого человека (peer).
 * @param {{campaignId?:string|null, goalId?:string|null}} l
 */
/** Воронка, которой принадлежит лид: кампания главнее цели. */
const leadScope = (l) => (l.campaignId ? `c:${l.campaignId}` : (l.goalId ? `g:${l.goalId}` : ''))

/**
 * Один ли это лид: та же воронка И тот же владелец.
 *
 * Владелец в сравнении нужен, потому что без цели и кампании область пустая — и лид
 * клиента A по контакту @vasya схлопывался бы с лидом клиента B по тому же контакту:
 * один видел бы в своей CRM движения чужой воронки.
 *
 * Пустой владелец у СОХРАНЁННОГО лида считаем совпадением и заполняем при обновлении:
 * на боевом сервере лиды копились, когда владельца не писали вовсе, и строгое сравнение
 * завело бы каждому из них дубль вместо продвижения по воронке.
 *
 * @param {object} stored лежащий в хранилище @param {object} fresh пришедший
 */
const sameLead = (stored, fresh) =>
  leadScope(stored) === leadScope(fresh) &&
  (!stored.userId || String(stored.userId) === String(fresh.userId || ''))

/** Терминальные статусы — их не откатываем при авто-обновлении (§9). */
const TERMINAL_LEAD_STATUSES = new Set(['target', 'closed'])

/**
 * §9: продвижение статуса лида ТОЛЬКО вперёд по воронке (авто-апдейт не понижает).
 * Терминальные (цель/закрыт) не откатываем. Чистая функция.
 * @param {string} current @param {string} next @returns {string}
 */
export function advanceLeadStatus(current, next) {
  if (!current) return next
  if (TERMINAL_LEAD_STATUSES.has(current)) return current
  return leadPriority(next) > leadPriority(current) ? next : current
}

/**
 * §9: авто-попадание лида в CRM — upsert по (goalId + peer). Существующий лид
 * продвигается по воронке вперёд (не откатывается), новый создаётся.
 * @param {object} input @returns {Promise<{lead: object, created: boolean}>}
 */
export async function upsertLead(input) {
  const clean = normalizeLead(input)
  if (!clean.peer) throw new Error('Укажите контакт лида (peer)')
  const key = normPeer(clean.peer)
  // Через mutateJson: воркер авто-ответчика зовёт upsert параллельно по разным диалогам,
  // и обычный read-modify-write терял бы часть лидов (последняя запись затирала файл).
  let result = { lead: null, created: false }
  await mutateJson(LEADS_FILE, (all) => {
    const i = all.findIndex((l) => normPeer(l.peer) === key && sameLead(l, clean))
    if (i === -1) {
      const lead = { id: `lead_${crypto.randomUUID().slice(0, 8)}`, ...clean, isHot: clean.status === 'hot', createdAt: Date.now(), updatedAt: Date.now() }
      all.unshift(lead)
      result = { lead, created: true }
      return all
    }
    // Досталось «ничьим» из прежних прогонов — закрепляем за тем, чья задача его ведёт.
    if (!all[i].userId && clean.userId) all[i].userId = clean.userId
    const advanced = advanceLeadStatus(all[i].status, clean.status)
    all[i].status = advanced
    all[i].isHot = advanced === 'hot'
    if (clean.accountId) all[i].accountId = clean.accountId
    // Кампанию проставляем, если её ещё нет: первый приведший её и «владеет».
    if (clean.campaignId && !all[i].campaignId) all[i].campaignId = clean.campaignId
    // Задачу-источник тоже фиксируем один раз — за лидом остаётся ПЕРВЫЙ прогон,
    // который его привёл (последующие касания статуса источник не переписывают).
    if (clean.taskId && !all[i].taskId) all[i].taskId = clean.taskId
    all[i].updatedAt = Date.now()
    result = { lead: all[i], created: false }
    return all
  }, [])
  return result
}

/** Карта peer→высший приоритет из лидов (для приоритезации диалогов §3.6). Чистая. */
export function leadPriorityMap(leads = []) {
  /** @type {Record<string, number>} */
  const m = {}
  for (const l of Array.isArray(leads) ? leads : []) {
    const key = normPeer(l.peer)
    if (!key) continue
    const p = leadPriority(l.status)
    if (m[key] == null || p > m[key]) m[key] = p
  }
  return m
}

/**
 * Приоритет диалога по связанному лиду (по username или id). Чистая.
 * Нет совпадения — приоритет как у «cold» (1), чтобы диалоги без лида шли после ответивших.
 * @param {{id?:string, entity?:{username?:string,id?:unknown}}} dialog @param {Record<string,number>} map
 */
export function dialogLeadPriority(dialog, map = {}) {
  const cands = [dialog?.entity?.username, dialog?.entity?.id, dialog?.id].map(normPeer).filter(Boolean)
  let best = 1
  for (const c of cands) if (map[c] != null && map[c] > best) best = map[c]
  return best
}

/** Отсортировать диалоги по приоритету связанных лидов (по убыванию). Чистая, стабильная. */
export function sortDialogsByLeadPriority(dialogs = [], leads = []) {
  const map = leadPriorityMap(leads)
  return [...(Array.isArray(dialogs) ? dialogs : [])]
    .map((d, i) => ({ d, i, p: dialogLeadPriority(d, map) }))
    .sort((a, b) => b.p - a.p || a.i - b.i) // приоритет ↓, при равенстве — исходный порядок
    .map((x) => x.d)
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
export async function leadStats(goalId, userId) {
  // Воронка — это деньги клиента: сколько написали, сколько ответили, сколько закрыли.
  // Без фильтра по владельцу `/stats` показывал воронку ВСЕЙ платформы.
  const leads = await listLeads({ ...(goalId ? { goalId } : {}), ...(userId ? { userId } : {}) })
  const by = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]))
  for (const l of leads) by[l.status] = (by[l.status] || 0) + 1
  return { total: leads.length, byStatus: by }
}
