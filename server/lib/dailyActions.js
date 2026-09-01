/**
 * Суточные счётчики действий на аккаунт (§6, enforcement safety-лимитов). Не даём аккаунту
 * превысить дневной потолок (комментарии/ЛС/вступления/реакции — см. safetyLimits.js).
 * Хранение — JSON data/daily-actions.json; путь через env DAILY_ACTIONS_FILE (тесты).
 */
import { dataPath, readJson, writeJson } from './jsonStore.js'
import { DAILY_LIMITS } from './safetyLimits.js'
import { getSupabase, supabaseEnabled } from './supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

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

/*
 * MR-290: счётчики живут в базе, файл остаётся запасным путём.
 *
 * Таблица `daily_actions` и функция `bump_daily_action` существовали с самого начала и ни
 * разу не вызывались — стор читал и писал файл. Это не мелочь: на потолках держится
 * защита аккаунта от бана, а файловый инкремент — это «прочитать, увеличить, записать».
 * Два воркера, увеличивающие счётчик одновременно, читают одно значение и пишут каждый
 * своё: одно действие не посчитано. «Иногда считает на единицу меньше» здесь означает
 * «иногда даёт превысить», и заметно это будет по бану, а не по логу.
 */

/**
 * Счётчики за ДЕНЬ в прежней форме: аккаунт → { date, counts }.
 * Форма сохранена ради чистых `countFrom`/`limitReachedFrom` — их зовут и снаружи.
 * @param {number} [now]
 */
async function load(now = Date.now()) {
  const db = sb()
  if (db) {
    const day = dayKey(now)
    // Берём только сегодняшний день: вчерашние счётчики не нужны никому, а таблица
    // растёт по дню на аккаунт и без отбора однажды поехала бы целиком.
    const { data, error } = await db.from('daily_actions').select('account_id, action, count').eq('day', day)
    if (!error) {
      const map = {}
      for (const r of data || []) {
        if (!map[r.account_id]) map[r.account_id] = { date: day, counts: {} }
        map[r.account_id].counts[r.action] = Number(r.count) || 0
      }
      return map
    }
  }
  const m = await readJson(FILE, {})
  return m && typeof m === 'object' ? m : {}
}

/** Достигнут ли суточный лимит (с чтением стораджа). */
export async function limitReached(accountId, action, now = Date.now()) {
  return limitReachedFrom(await load(now), accountId, action, now)
}

/**
 * Сводка суточной активности аккаунта: сегодняшние счётчики против потолков (§6).
 * Для UI (вкладка «Здоровье»): понятно, почему аккаунт пропускается модулями.
 */
export async function dailySummary(accountId, now = Date.now()) {
  const map = await load(now)
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
  const map = await load(now)
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

/**
 * Инкремент счётчика действия аккаунта на сегодня (сброс при новом дне).
 * @returns {Promise<number|null>} новое значение счётчика; null — посчитали в файле.
 */
export async function incAction(accountId, action, now = Date.now()) {
  if (!accountId || !action) return null
  const key = dayKey(now)
  const db = sb()
  if (db) {
    // Одним запросом, а не «прочитать-увеличить-записать»: два воркера иначе пробили бы
    // потолок незаметно. Функция сразу возвращает НОВОЕ значение — вызывающий узнаёт,
    // упёрся он в лимит, не делая второго запроса.
    const { data, error } = await db.rpc('bump_daily_action', { p_account: accountId, p_day: key, p_action: action })
    if (!error) return Number(data) || 0
    // Аккаунта нет в базе — считать его лимит не для кого; в файл такое не дублируем.
    if (String(error.code) === '23503') return null
  }
  const map = await readJson(FILE, {})
  const all = map && typeof map === 'object' ? map : {}
  let rec = all[accountId]
  if (!rec || rec.date !== key) { rec = { date: key, counts: {} }; all[accountId] = rec }
  rec.counts[action] = Number(rec.counts[action] || 0) + 1
  await writeJson(FILE, all)
  return rec.counts[action]
}
