/**
 * Суточные счётчики действий на аккаунт (§6, enforcement safety-лимитов). Не даём аккаунту
 * превысить дневной потолок (комментарии/ЛС/вступления/реакции — см. safetyLimits.js).
 * Хранение — JSON data/daily-actions.json; путь через env DAILY_ACTIONS_FILE (тесты).
 */
import { dataPath, readJson, writeJson } from './jsonStore.js'
import { DAILY_LIMITS } from './safetyLimits.js'

const FILE = process.env.DAILY_ACTIONS_FILE || dataPath('daily-actions.json')

/** Ключ дня YYYY-MM-DD (локальный). @param {number} [now] */
export function dayKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Сколько действий данного типа сделал аккаунт сегодня. Чистая (по переданной карте). */
export function countFrom(map, accountId, action, now = Date.now()) {
  const rec = map?.[accountId]
  if (!rec || rec.date !== dayKey(now)) return 0
  return Number(rec.counts?.[action] || 0)
}

/** Достигнут ли суточный лимит действия. Чистая. @param {object} map */
export function limitReachedFrom(map, accountId, action, now = Date.now()) {
  const cap = DAILY_LIMITS[action]?.max
  if (!cap) return false // нет лимита на этот тип — не ограничиваем
  return countFrom(map, accountId, action, now) >= cap
}

async function load() { const m = await readJson(FILE, {}); return m && typeof m === 'object' ? m : {} }

/** Достигнут ли суточный лимит (с чтением стораджа). */
export async function limitReached(accountId, action, now = Date.now()) {
  return limitReachedFrom(await load(), accountId, action, now)
}

/**
 * Сводка суточной активности аккаунта: сегодняшние счётчики против потолков (§6).
 * Для UI (вкладка «Здоровье»): понятно, почему аккаунт пропускается модулями.
 */
export async function dailySummary(accountId, now = Date.now()) {
  const map = await load()
  const date = dayKey(now)
  const items = ['comments', 'dm', 'joins', 'reactions'].map((action) => {
    const used = countFrom(map, accountId, action, now)
    const cap = DAILY_LIMITS[action]?.max ?? 0
    return { action, used, cap, reached: cap ? used >= cap : false }
  })
  return { accountId, date, items }
}

/**
 * Сводка по всем аккаунтам, у которых сегодня есть активность (одно чтение стора).
 * Для индикатора §6 в списке аккаунтов — какие аккаунты «упёрлись» в потолок.
 * @returns {Promise<Record<string, {items: {action,used,cap,reached}[], anyReached: boolean}>>}
 */
export async function dailySummaryAll(now = Date.now()) {
  const map = await load()
  const date = dayKey(now)
  const out = {}
  for (const [accountId, rec] of Object.entries(map)) {
    if (!rec || rec.date !== date) continue // только сегодняшние
    const items = ['comments', 'dm', 'joins', 'reactions'].map((action) => {
      const used = Number(rec.counts?.[action] || 0)
      const cap = DAILY_LIMITS[action]?.max ?? 0
      return { action, used, cap, reached: cap ? used >= cap : false }
    })
    out[accountId] = { items, anyReached: items.some((x) => x.reached) }
  }
  return out
}

/** Инкремент счётчика действия аккаунта на сегодня (сброс при новом дне). */
export async function incAction(accountId, action, now = Date.now()) {
  if (!accountId || !action) return
  const map = await load()
  const key = dayKey(now)
  let rec = map[accountId]
  if (!rec || rec.date !== key) { rec = { date: key, counts: {} }; map[accountId] = rec }
  rec.counts[action] = Number(rec.counts[action] || 0) + 1
  await writeJson(FILE, map)
}
