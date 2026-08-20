/**
 * MR-173 (созвон 19.08): подписки РЕЛЯЦИОННО — одна строка на (пользователь, модуль),
 * вместо JSON-массива в одной строке subscriptions. Набор = множество строк.
 *
 * Почему так (баги старой модели):
 *  - докупка модуля перезаписывала весь набор (setUserModules сохранял новый список
 *    целиком) → у остальных модулей терялся их срок; здесь докупка = INSERT новых строк,
 *    существующие не трогаем;
 *  - оплаченный модуль можно было «оплатить» повторно → тут ON CONFLICT(user_id,module_key)
 *    гасит дубль, а оплата считается только за реально добавленные строки.
 *
 * «Все модули» ('all') представляем ОДНОЙ строкой с module_key = '*' (реляционно, без
 * спец-JSON): пространство/дев-режим открывают всё, не перечисляя 14 ключей.
 *
 * MR-150 (Шаг 2, связано): billing_day (день оплаты) + last_credit_month ('YYYY-MM')
 * на строке — для ежемесячного начисления токенов с идемпотентностью (крон).
 *
 * Файловый бэкенд (дев/тесты) — тот же интерфейс: data/user-subscriptions.json,
 * { userId: [ {module, expiresAt, billingDay, lastCreditMonth} ] }.
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const FILE = () => process.env.USER_SUBS_FILE || dataPath('user-subscriptions.json')

/** Ключ «все модули» — одна строка вместо перечисления. */
export const ALL_MODULES = '*'
const iso = (ms) => (ms ? new Date(ms).toISOString() : null)
const ms = (v) => (v ? new Date(v).getTime() : null)
const norm = (userId) => String(userId || '__default')

/**
 * Активные модули пользователя + сроки. Истёкшие (expires_at в прошлом) НЕ отдаём —
 * подписка на модуль закончилась.
 * @returns {Promise<{ modules: string[]|'all', expiresAt: number|null, rows: Array<{module:string, expiresAt:number|null}> }>}
 */
export async function readModules(userId) {
  const uid = norm(userId)
  const now = Date.now()
  const active = (rows) => rows.filter((r) => r.expiresAt == null || r.expiresAt > now)
  const db = sb()
  let rows
  if (db) {
    const { data } = await db.from('user_subscriptions').select('module_key, expires_at').eq('user_id', uid)
    rows = (data || []).map((r) => ({ module: r.module_key, expiresAt: ms(r.expires_at) }))
  } else {
    const all = await readJson(FILE(), {})
    rows = Array.isArray(all?.[uid]) ? all[uid].map((r) => ({ module: r.module, expiresAt: r.expiresAt ?? null })) : []
  }
  const act = active(rows)
  // '*' среди активных → набор = 'all'.
  if (act.some((r) => r.module === ALL_MODULES)) {
    const star = act.find((r) => r.module === ALL_MODULES)
    return { modules: 'all', expiresAt: star.expiresAt ?? null, rows: act }
  }
  const modules = act.map((r) => r.module)
  // Общий срок для показа — ближайшее будущее истечение (или null, если бессрочно).
  const dues = act.map((r) => r.expiresAt).filter((v) => v != null)
  const expiresAt = dues.length ? Math.min(...dues) : null
  return { modules, expiresAt, rows: act }
}

/** День месяца (1..31) из времени оплаты — по нему ежемесячно начисляем токены (MR-150). */
function billingDayFrom(startMs) { return new Date(startMs || Date.now()).getUTCDate() }

/**
 * Установить ТОЧНЫЙ набор модулей пользователя: добавить недостающие, убрать лишние,
 * а у уже имеющихся модулей срок/начисление НЕ сбрасывать (это и чинит «докупка затирает
 * набор»). 'all' → одна строка '*'.
 * @param {string} userId
 * @param {string[]|'all'} modules
 * @param {{months?:number, startMs?:number}} [opts]
 */
export async function setModules(userId, modules, opts = {}) {
  const uid = norm(userId)
  const startMs = opts.startMs || Date.now()
  const expiresMs = opts.months > 0 ? startMs + Math.round(Number(opts.months) * 30 * 24 * 60 * 60 * 1000) : null
  const wanted = modules === 'all' ? [ALL_MODULES] : [...new Set((modules || []).map(String).filter(Boolean))]
  const day = billingDayFrom(startMs)
  const db = sb()
  if (db) {
    const { data: cur } = await db.from('user_subscriptions').select('module_key').eq('user_id', uid)
    const have = new Set((cur || []).map((r) => r.module_key))
    const toAdd = wanted.filter((m) => !have.has(m))
    const toRemove = [...have].filter((m) => !wanted.includes(m))
    if (toRemove.length) await db.from('user_subscriptions').delete().eq('user_id', uid).in('module_key', toRemove)
    if (toAdd.length) {
      await db.from('user_subscriptions').insert(toAdd.map((m) => ({
        user_id: uid, module_key: m, started_at: iso(startMs), expires_at: iso(expiresMs),
        billing_day: day, last_credit_month: null,
      })))
    }
    // Продление периода: у ОСТАВЛЕННЫХ модулей двигаем срок вперёд (оплата продлевает набор).
    const kept = wanted.filter((m) => have.has(m))
    if (kept.length && expiresMs) {
      await db.from('user_subscriptions').update({ expires_at: iso(expiresMs), updated_at: new Date().toISOString() })
        .eq('user_id', uid).in('module_key', kept)
    }
    return readModules(uid)
  }
  await mutateJson(FILE(), (all) => {
    const next = { ...(all || {}) }
    const prev = Array.isArray(next[uid]) ? next[uid] : []
    const byMod = new Map(prev.map((r) => [r.module, r]))
    const out = []
    for (const m of wanted) {
      const ex = byMod.get(m)
      out.push(ex
        ? { ...ex, expiresAt: expiresMs ?? ex.expiresAt } // продлеваем, начисление не сбрасываем
        : { module: m, expiresAt: expiresMs, billingDay: day, lastCreditMonth: null })
    }
    next[uid] = out
    return next
  }, {})
  return readModules(uid)
}

/**
 * ДОКУПКА: добавить модули к набору, не трогая существующие (их срок и начисление целы).
 * Возвращает какие реально добавлены (за них берётся оплата).
 * @returns {Promise<{ added: string[] }>}
 */
export async function addModules(userId, modules, opts = {}) {
  const uid = norm(userId)
  const startMs = opts.startMs || Date.now()
  const expiresMs = opts.months > 0 ? startMs + Math.round(Number(opts.months) * 30 * 24 * 60 * 60 * 1000) : null
  const day = billingDayFrom(startMs)
  const wanted = [...new Set((modules || []).map(String).filter(Boolean))]
  const db = sb()
  if (db) {
    const { data: cur } = await db.from('user_subscriptions').select('module_key').eq('user_id', uid)
    const have = new Set((cur || []).map((r) => r.module_key))
    const added = wanted.filter((m) => !have.has(m))
    if (added.length) {
      await db.from('user_subscriptions').insert(added.map((m) => ({
        user_id: uid, module_key: m, started_at: iso(startMs), expires_at: iso(expiresMs),
        billing_day: day, last_credit_month: null,
      })))
    }
    return { added }
  }
  let added = []
  await mutateJson(FILE(), (all) => {
    const next = { ...(all || {}) }
    const prev = Array.isArray(next[uid]) ? next[uid] : []
    const have = new Set(prev.map((r) => r.module))
    added = wanted.filter((m) => !have.has(m))
    next[uid] = [...prev, ...added.map((m) => ({ module: m, expiresAt: expiresMs, billingDay: day, lastCreditMonth: null }))]
    return next
  }, {})
  return { added }
}

/**
 * MR-150: подписки, которым СЕГОДНЯ положено месячное начисление токенов — день оплаты
 * совпал с текущим и этот месяц ещё не начислен, подписка не истекла. Возвращаем по
 * пользователям, чтобы начислить сумму monthlyTokens активных модулей.
 * @param {number} nowMs
 * @returns {Promise<Array<{ userId:string, modules:string[], ids:Array<number|string> }>>}
 */
export async function dueForCredit(nowMs = Date.now()) {
  const d = new Date(nowMs)
  const today = d.getUTCDate()
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const isDue = (r) => r.billingDay === today && r.lastCreditMonth !== month && (r.expiresAt == null || r.expiresAt > nowMs) && r.module !== ALL_MODULES
  const db = sb()
  const byUser = new Map()
  if (db) {
    const { data } = await db.from('user_subscriptions')
      .select('id, user_id, module_key, expires_at, billing_day, last_credit_month')
      .eq('billing_day', today).neq('last_credit_month', month)
    for (const r of data || []) {
      const row = { id: r.id, module: r.module_key, expiresAt: ms(r.expires_at), billingDay: r.billing_day, lastCreditMonth: r.last_credit_month }
      if (!isDue(row)) continue
      const u = byUser.get(r.user_id) || { userId: r.user_id, modules: [], ids: [] }
      u.modules.push(r.module_key); u.ids.push(r.id); byUser.set(r.user_id, u)
    }
  } else {
    const all = await readJson(FILE(), {})
    for (const [uid, rows] of Object.entries(all || {})) {
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!isDue(r)) continue
        const u = byUser.get(uid) || { userId: uid, modules: [], ids: [] }
        u.modules.push(r.module); u.ids.push(r.module); byUser.set(uid, u) // в файле id = module
      }
    }
  }
  return [...byUser.values()]
}

/** Пометить строки как начисленные за месяц (идемпотентность крона). */
export async function markCredited(userId, moduleKeysOrIds, month) {
  const uid = norm(userId)
  const db = sb()
  if (db) {
    await db.from('user_subscriptions').update({ last_credit_month: month, updated_at: new Date().toISOString() })
      .eq('user_id', uid).in('id', moduleKeysOrIds)
    return
  }
  await mutateJson(FILE(), (all) => {
    const next = { ...(all || {}) }
    const rows = Array.isArray(next[uid]) ? next[uid] : []
    const set = new Set(moduleKeysOrIds)
    next[uid] = rows.map((r) => (set.has(r.module) ? { ...r, lastCreditMonth: month } : r))
    return next
  }, {})
}
