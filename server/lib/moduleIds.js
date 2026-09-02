/**
 * MR-290: модули связями — справочник и работа с таблицами `*_modules`.
 *
 * Таблицы связей (`campaign_modules`, `wallet_log_modules`, `bundle_modules`) ссылаются на
 * `modules.id`, а весь остальной код оперирует ключом: ключ лежит в настройках задач, в
 * маршрутах, в правах. Значит перевод нужен на каждой записи и на каждом чтении связей —
 * и написан он должен быть один раз, а не по разу у каждого владельца связи.
 *
 * Кэш справочника здесь уместен, а обычно нет. Модулей пятнадцать, и меняются они при
 * выкате новой версии платформы, а не в работе: пополняет их `syncModuleLinks` из
 * зашитого в код списка. Ходить за ними в базу на каждое чтение кампании — лишний запрос
 * на строку списка. Но и вечный кэш не годится: после добавления модуля процесс живёт
 * дальше, и новый ключ обязан появиться без рестарта — отсюда короткий TTL.
 */
import { getSupabase, supabaseEnabled } from './supabase.js'

const TTL_MS = 60_000
let cache = null // { byKey: Map, byId: Map, ts: number }

/** Сбросить кэш немедленно — после пополнения справочника модулей. */
export function invalidateModuleIds() { cache = null }

/**
 * Справочник модулей в обе стороны.
 * @param {any} [db] клиент; по умолчанию общий. Параметр нужен тестам и скриптам.
 * @returns {Promise<{byKey: Map<string, number>, byId: Map<string, string>} | null>}
 *   null — базы нет или справочник недоступен; вызывающий обязан уметь без него.
 */
export async function moduleIdMaps(db = null) {
  const client = db || (supabaseEnabled() ? getSupabase() : null)
  if (!client) return null
  // Кэш общий и только для общего клиента: подставленный в тесте db не должен
  // ни читать чужой кэш, ни оставлять свой — иначе тесты начнут влиять друг на друга.
  if (!db && cache && Date.now() - cache.ts < TTL_MS) return cache
  const { data, error } = await client.from('modules').select('id, key')
  if (error || !data) return null
  const maps = {
    byKey: new Map(data.map((m) => [m.key, m.id])),
    // Ключ в карте — СТРОКА: id приезжает то числом, то строкой (bigint через PostgREST),
    // а `Map` различает 7 и '7'. Промах здесь выглядел бы как «модуль исчез из кампании».
    byId: new Map(data.map((m) => [String(m.id), m.key])),
    ts: Date.now(),
  }
  if (!db) cache = maps
  return maps
}

/**
 * Прочитать связи с модулями: владелец → ключи модулей ПО ПОРЯДКУ.
 *
 * Один запрос на весь список, а не по запросу на владельца: списки кампаний и журнала
 * лежат на горячем пути, и N+1 там заметен сразу.
 *
 * @param {any} db @param {string} table таблица связей @param {string} ownerCol колонка владельца
 * @param {Array<string|number>} ids владельцы, которых читаем
 * @returns {Promise<Map<string,string[]>|null>} null — прочитать не удалось (миграция не
 *   доехала); вызывающий должен вернуться к старой колонке-массиву, а НЕ считать, что
 *   модулей нет. Пустая карта — это другое: связи прочитаны, их просто нет.
 */
export async function readModuleLinks(db, table, ownerCol, ids) {
  if (!ids.length) return new Map()
  const maps = await moduleIdMaps(db)
  if (!maps) return null
  const { data, error } = await db.from(table)
    .select(`${ownerCol}, module_id, position`).in(ownerCol, ids).order('position', { ascending: true })
  if (error) return null
  const out = new Map()
  for (const r of data || []) {
    const key = maps.byId.get(String(r.module_id))
    if (!key) continue
    const owner = String(r[ownerCol])
    if (!out.has(owner)) out.set(owner, [])
    out.get(owner).push(key)
  }
  return out
}

/**
 * Привести связи одного владельца к заданным ключам.
 *
 * Порядок значащий и хранится в `position`: `modules[0]` — модуль, которым кампания
 * подписана в списке. В массиве порядок был неявным, и потерять его было бы легко.
 *
 * @param {any} db @param {string} table @param {string} ownerCol
 * @param {string|number} ownerId @param {string[]} keys
 */
export async function writeModuleLinks(db, table, ownerCol, ownerId, keys) {
  const maps = await moduleIdMaps(db)
  if (!maps) throw new Error(`[${table}] нет справочника модулей — связи не записаны`)
  // Неизвестный ключ отбрасываем: вставка с ним упёрлась бы во внешний ключ и уронила
  // бы всю запись целиком. Владельцу связи важнее сохраниться, чем сохранить опечатку.
  const ids = [...new Set((keys || []).map((k) => maps.byKey.get(k)).filter((v) => v != null))]
  // Сначала снимаем лишнее, потом пишем нужное: обратный порядок на миг оставил бы
  // владельца с обоими наборами сразу, и читатель между ними увидел бы лишний модуль.
  const { error: delErr } = await db.from(table).delete().eq(ownerCol, ownerId)
  if (delErr) throw new Error(`[${table}] не удалось снять старые связи: ${delErr.message}`)
  if (!ids.length) return
  const rows = ids.map((module_id, i) => ({ [ownerCol]: ownerId, module_id, position: i }))
  const { error } = await db.from(table).upsert(rows, { onConflict: `${ownerCol},module_id` })
  if (error) throw new Error(`[${table}] не удалось сохранить модули: ${error.message}`)
}
