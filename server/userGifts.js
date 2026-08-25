/**
 * MR-189: подарочные ⚡ — выдать ОДИН раз и запомнить, что выдали.
 *
 * Созвон 24.08: «подарочные — они один раз только добавляются, и всё». При разборе
 * выяснилось, что подарок вообще не начислялся: он считался в стоимости набора и
 * показывался на витрине, но ни оплата подписки, ни ежемесячный крон его не выдавали.
 *
 * Здесь — журнал выданного. Он привязан к паре «человек + модуль» и переживает отключение
 * модуля: вернул парсер в подписку через месяц — подарок второй раз не полагается.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
/** Путь вычисляем лениво: тесты подменяют его через env уже после импорта модуля. */
const FILE = () => process.env.USER_GIFTS_FILE || dataPath('user-gifts.json')
const key = (userId, moduleKey) => `${userId}::${moduleKey}`

/** Модули, за которые подарок этому человеку УЖЕ выдавали. */
export async function creditedGifts(userId, moduleKeys = []) {
  const uid = String(userId || '').trim()
  if (!uid || !moduleKeys.length) return new Set()
  const db = sb()
  if (db) {
    const { data, error } = await db.from('user_gifts').select('module_key').eq('user_id', uid).in('module_key', moduleKeys)
    // Таблицы ещё нет (миграция не накатана) — считаем, что не выдавали НИЧЕГО и подарок
    // не начисляем: лучше не дать, чем раздать повторно и не заметить.
    if (error) return new Set(moduleKeys)
    return new Set((data || []).map((r) => r.module_key))
  }
  const all = await readJson(FILE(), {})
  return new Set(moduleKeys.filter((k) => all[key(uid, k)]))
}

/**
 * Сколько ⚡ подарка положено человеку за ЭТИ модули и за какие именно.
 * Уже выданные не считаем.
 * @returns {Promise<{ coins:number, modules:string[] }>}
 */
export async function pendingGift(userId, moduleKeys = [], giftMap = {}) {
  // Без владельца подарок не считаем: записать выдачу будет некуда, и он «полагался» бы
  // при каждой проверке заново.
  if (!String(userId || '').trim()) return { coins: 0, modules: [] }
  const keys = [...new Set(moduleKeys.filter(Boolean))].filter((k) => Number(giftMap[k]) > 0)
  if (!keys.length) return { coins: 0, modules: [] }
  const already = await creditedGifts(userId, keys)
  const fresh = keys.filter((k) => !already.has(k))
  return { coins: fresh.reduce((s, k) => s + Number(giftMap[k] || 0), 0), modules: fresh }
}

/** Записать факт выдачи. Повторный вызов ничего не задваивает. */
export async function markGifted(userId, moduleKeys = [], giftMap = {}) {
  const uid = String(userId || '').trim()
  const keys = [...new Set(moduleKeys.filter(Boolean))]
  if (!uid || !keys.length) return
  const db = sb()
  if (db) {
    const rows = keys.map((k) => ({ user_id: uid, module_key: k, coins: Math.round(Number(giftMap[k]) || 0) }))
    // ignoreDuplicates: гонка двух оплат не должна упасть с ошибкой уникальности — подарок
    // и так уже записан, второй раз его выдавать не нужно.
    await db.from('user_gifts').upsert(rows, { onConflict: 'user_id,module_key', ignoreDuplicates: true })
    return
  }
  const all = await readJson(FILE(), {})
  for (const k of keys) all[key(uid, k)] = { coins: Math.round(Number(giftMap[k]) || 0), at: Date.now() }
  await writeJson(FILE(), all)
}
