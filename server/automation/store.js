/**
 * Правила автоматизации — расписание, по которому платформа сама запускает кампании.
 *
 * С 27.08 (MR-186) хранятся в ОБЩЕЙ БАЗЕ (`automation_rules` + `automation_rule_accounts`).
 * До этого стор писал в data/automation/rules.json, ветки Supabase не было. По этим
 * правилам тратятся аккаунты и деньги клиента: пропал диск — расписания нет, и кампании
 * молча перестали запускаться. При втором инстансе у каждого сервера был бы свой файл, и
 * правило, выключенное на одном, на другом продолжало бы работать.
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from '../lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from '../lib/supabase.js'

/** Путь ленивый — иначе тест, выставивший env после импорта, пишет в боевой файл. */
const rulesFile = () => process.env.AUTOMATION_FILE || dataPath('automation/rules.json')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Таблиц ещё нет (миграция не накатана) — планировщику нечего запускать, но он жив. */
const isMissingTable = (error) =>
  !!error && /automation_rules|automation_rule_accounts|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

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
 * @property {string} userId  // владелец пространства, см. createRule
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

/**
 * Строка базы → правило. Расписание собираем обратно ТОЛЬКО из заполненных колонок:
 * у правила с интервалом не должно вдруг появиться поле `time`, иначе оно поедет
 * дальше в настройки и в сравнения.
 */
const fromRow = (r, accountIds = []) => ({
  id: r.id,
  name: r.name,
  userId: r.user_id || '',
  enabled: !!r.enabled,
  moduleKey: r.module_key || '',
  campaignId: r.campaign_id ?? null,
  accountIds,
  settings: r.settings ?? {},
  schedule: {
    type: r.schedule_type,
    ...(r.schedule_at != null ? { at: Number(r.schedule_at) } : {}),
    ...(r.schedule_interval_minutes != null ? { intervalMinutes: Number(r.schedule_interval_minutes) } : {}),
    ...(r.schedule_time != null ? { time: r.schedule_time } : {}),
  },
  lastRun: r.last_run == null ? null : Number(r.last_run),
  lastStatus: r.last_status ?? null,
  lastTaskId: r.last_task_id ?? null,
  nextRun: r.next_run == null ? null : Number(r.next_run),
  createdAt: Number(r.created_at) || 0,
  updatedAt: Number(r.updated_at) || 0,
})

const toRow = (rule) => ({
  id: rule.id,
  user_id: rule.userId || null,
  name: rule.name,
  enabled: !!rule.enabled,
  module_key: rule.moduleKey || '',
  campaign_id: rule.campaignId ?? null,
  settings: rule.settings ?? {},
  schedule_type: rule.schedule?.type || 'interval',
  schedule_at: rule.schedule?.at ?? null,
  schedule_interval_minutes: rule.schedule?.intervalMinutes ?? null,
  schedule_time: rule.schedule?.time ?? null,
  last_run: rule.lastRun ?? null,
  last_status: rule.lastStatus ?? null,
  last_task_id: rule.lastTaskId ?? null,
  next_run: rule.nextRun ?? null,
  created_at: rule.createdAt,
  updated_at: rule.updatedAt,
})

/** Записать аккаунты правила: сначала убрать прежние, потом положить новые в их порядке. */
async function saveAccounts(db, ruleId, accountIds) {
  const { error: delErr } = await db.from('automation_rule_accounts').delete().eq('rule_id', ruleId)
  if (delErr && !isMissingTable(delErr)) throw new Error(`Не удалось обновить аккаунты правила: ${delErr.message}`)
  // Дубли схлопываем до записи: ключ (правило, аккаунт) их не примет, а один и тот же
  // аккаунт дважды в правиле означал бы двойную норму действий по нему.
  const unique = [...new Set((accountIds || []).map(String).filter(Boolean))]
  if (!unique.length) return
  const rows = unique.map((account_id, position) => ({ rule_id: ruleId, account_id, position }))
  const { error } = await db.from('automation_rule_accounts').insert(rows)
  if (error && !isMissingTable(error)) throw new Error(`Не удалось сохранить аккаунты правила: ${error.message}`)
}

export async function listRules() {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('automation_rules').select('*').order('created_at', { ascending: false })
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать правила автоматизации: ${error.message}`)
    }
    const rows = data || []
    if (!rows.length) return []
    // Аккаунты дочитываем ОДНИМ запросом: планировщик читает список каждые 30 секунд,
    // и запрос на правило превратил бы тик в лесенку из десятков обращений.
    const { data: aRows, error: aErr } = await db
      .from('automation_rule_accounts')
      .select('*')
      .in('rule_id', rows.map((r) => r.id))
      .order('position', { ascending: true })
    if (aErr && !isMissingTable(aErr)) throw new Error(`Не удалось прочитать аккаунты правил: ${aErr.message}`)
    const byRule = new Map()
    for (const a of aRows || []) {
      if (!byRule.has(a.rule_id)) byRule.set(a.rule_id, [])
      byRule.get(a.rule_id).push(a.account_id)
    }
    return rows.map((r) => fromRow(r, byRule.get(r.id) || []))
  }
  const data = await readJson(rulesFile(), { rules: [] })
  return Array.isArray(data?.rules) ? data.rules : []
}

async function saveRules(rules) {
  await writeJson(rulesFile(), { rules, updatedAt: Date.now() })
}

/**
 * Владелец правила (`userId`).
 *
 * У правила автоматизации владельца не было вообще, а список отдавался целиком — то есть
 * наружу уходили состав чужих аккаунтов, привязка к кампании и расписание, а кнопка
 * «Запустить сейчас» позволяла сжечь чужие аккаунты и чужие деньги по чужому правилу.
 *
 * Правила, заведённые до этого поля, остаются без владельца — их видит только админ
 * (`ownedForRequest`); привязать их задним числом к какому-то клиенту нельзя.
 * ВАЖНО: планировщик (scheduler.js) читает стор напрямую и владельца не смотрит —
 * старые правила продолжают отрабатывать по расписанию как раньше.
 *
 * @param {Partial<AutomationRule>} input
 */
export async function createRule(input) {
  const now = Date.now()
  const rule = /** @type {AutomationRule} */ ({
    id: newId(),
    name: String(input?.name || '').trim() || 'Правило автоматизации',
    userId: String(input?.userId || '').trim() || '',
    enabled: input?.enabled !== false,
    moduleKey: String(input?.moduleKey || ''),
    campaignId: input?.campaignId ? String(input.campaignId) : null, // §6: правило крепится к кампании
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

  const db = sb()
  if (db) {
    const { error } = await db.from('automation_rules').insert(toRow(rule))
    if (error) {
      if (isMissingTable(error)) throw new Error('Автоматизация временно недоступна: не применена миграция базы')
      throw new Error(`Не удалось создать правило: ${error.message}`)
    }
    await saveAccounts(db, rule.id, rule.accountIds)
    return rule
  }
  const rules = await listRules()
  rules.unshift(rule)
  // Потолок в 200 нужен только файлу: он переписывается целиком. В базе правила сверх
  // потолка не выбрасываются — раньше самые старые молча удалялись при добавлении нового.
  await saveRules(rules.slice(0, 200))
  return rule
}

/** @param {string} id @param {Partial<AutomationRule>} patch */
export async function updateRule(id, patch) {
  const db = sb()
  if (db) {
    const rules = await listRules()
    const cur = rules.find((r) => r.id === id)
    if (!cur) return null
    const next = applyPatch(cur, patch)
    const { error } = await db.from('automation_rules').update(toRow(next)).eq('id', id)
    if (error && !isMissingTable(error)) throw new Error(`Не удалось изменить правило: ${error.message}`)
    if (patch?.accountIds !== undefined) await saveAccounts(db, id, next.accountIds)
    return next
  }
  const rules = await listRules()
  const idx = rules.findIndex((r) => r.id === id)
  if (idx === -1) return null
  rules[idx] = applyPatch(rules[idx], patch)
  await saveRules(rules)
  return rules[idx]
}

/** Собрать новое состояние правила из патча. Вынесено, чтобы оба режима меняли его одинаково. */
function applyPatch(cur, patch) {
  const next = {
    ...cur,
    ...(patch?.name !== undefined ? { name: String(patch.name).trim() || cur.name } : {}),
    ...(patch?.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
    ...(patch?.moduleKey !== undefined ? { moduleKey: String(patch.moduleKey) } : {}),
    ...(patch?.campaignId !== undefined ? { campaignId: patch.campaignId ? String(patch.campaignId) : null } : {}),
    ...(patch?.accountIds !== undefined ? { accountIds: Array.isArray(patch.accountIds) ? patch.accountIds : [] } : {}),
    ...(patch?.settings !== undefined ? { settings: patch.settings && typeof patch.settings === 'object' ? patch.settings : {} } : {}),
    ...(patch?.schedule !== undefined ? { schedule: sanitizeSchedule(patch.schedule) } : {}),
    ...(patch?.lastRun !== undefined ? { lastRun: patch.lastRun } : {}),
    ...(patch?.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
    ...(patch?.lastTaskId !== undefined ? { lastTaskId: patch.lastTaskId } : {}),
    updatedAt: Date.now(),
  }
  next.nextRun = computeNextRun(next)
  return next
}

/** @param {string} id */
export async function deleteRule(id) {
  const db = sb()
  if (db) {
    // Аккаунты правила уходят сами: внешний ключ объявлен с `on delete cascade`.
    const { data, error } = await db.from('automation_rules').delete().eq('id', id).select('id')
    if (error) {
      if (isMissingTable(error)) return false
      throw new Error(`Не удалось удалить правило: ${error.message}`)
    }
    return (data || []).length > 0
  }
  const rules = await listRules()
  const next = rules.filter((r) => r.id !== id)
  if (next.length === rules.length) return false
  await saveRules(next)
  return true
}

/*
 * `replaceRules` (массовое сохранение «для планировщика») убрана: она была экспортирована,
 * но не вызывалась ниоткуда — планировщик правит правила по одному через updateRule.
 * В режиме базы такая функция ещё и опасна: перезапись всего набора затёрла бы правила,
 * заведённые на другом инстансе между чтением и записью.
 */

/**
 * §6: автоматизация крепится к КАМПАНИИ (или к «голому» модулю — legacy).
 * Под кампанией модуль/аккаунты/цель берём из неё: нельзя автоматизировать
 * ненастроенный модуль. Чистая функция.
 * @param {{moduleKey?:string, campaignId?:string|null, accountIds?:string[], settings?:object}} rule
 * @param {{id:string, moduleKey:string, accountIds?:string[], settings?:object, goalId?:string|null}|null} campaign
 * @returns {{moduleKey: string, settings: object}}
 */
export function resolveRuleTarget(rule, campaign) {
  if (campaign) {
    return {
      moduleKey: campaign.moduleKey,
      settings: {
        ...(campaign.settings || {}),
        ...(rule?.settings || {}),
        // аккаунты правила приоритетнее, иначе — закреплённые за кампанией
        accountIds: (rule?.accountIds?.length ? rule.accountIds : campaign.accountIds) || [],
        ...(campaign.goalId ? { goalId: campaign.goalId } : {}),
        campaignId: campaign.id,
      },
    }
  }
  return {
    moduleKey: rule?.moduleKey,
    settings: { ...(rule?.settings || {}), accountIds: rule?.accountIds || rule?.settings?.accountIds || [] },
  }
}
