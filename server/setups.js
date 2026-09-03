/**
 * MR-149 (созвон 19.08): готовые сетапы — ИЗ БД, не из кода.
 *
 * Сетап — скидочный набор модулей: клиент берёт «Аутрич» и платит на 20 % меньше
 * суммы входящих модулей. Раньше три сетапа были захардкожены в pricing.js (SETUPS);
 * заказчик: «экономики в коде быть не должно, правится из админки». Здесь — тонкий
 * слой над БД (таблицы setups + setup_modules, РЕЛЯЦИОННО, без JSON).
 *
 * Отличие от bundles: у сетапа СКИДКА (доля от прайса), у bundle — ЯВНАЯ цена. Сетап
 * пересчитывается при изменении цен модулей, bundle — нет. `all_modules` — «Всё
 * включено»: состав = все модули платформы, включает новые сам.
 *
 * Файловый режим (дев/тесты) — БД нет, база остаётся код-константой SETUPS: пустой
 * стор = поведение ровно как раньше, существующие тесты не меняются.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { SETUPS, MODULE_MONTH_PRICE } from './pricing.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Все известные ключи модулей — состав «Всё включено» (all_modules). */
const allModuleKeys = () => Object.keys(MODULE_MONTH_PRICE)

// Кэш: сетапы меняются редко (правка из админки), а listSetups — на пути витрины и
// СПИСАНИЯ. Лишний двойной запрос (setups + setup_modules) на каждую покупку не нужен.
let _cache = null // { data: [...], ts }
const TTL = 60_000
export function invalidateSetups() { _cache = null }

/**
 * Список сетапов: [{ id, name, hint, discount, modules[] }] — та же форма, что код-SETUPS,
 * чтобы subscriptionCost работал одинаково с БД и без неё.
 * @returns {Promise<Array<{id:string,name:string,hint:string,discount:number,modules:string[]}>>}
 */
export async function listSetups() {
  const db = sb()
  if (!db) return SETUPS // код-фолбек: дев/тесты
  if (_cache && Date.now() - _cache.ts < TTL) return _cache.data
  try {
    const { data: rows, error } = await db.from('setups').select('*').order('sort', { ascending: true })
    // supabase-js НЕ бросает на отсутствующую таблицу/ошибку — возвращает { error }. Без этой
    // проверки до применения миграции витрина осталась бы без сетапов, а списание — без скидок
    // (клиента зарядили бы полную цену). Поэтому при ошибке — код-дефолт SETUPS.
    if (error) return SETUPS
    const { data: mods } = await db.from('setup_modules').select('setup_id, module_key')
    const byId = {}
    for (const m of mods || []) (byId[m.setup_id] ||= []).push(m.module_key)
    const list = (rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      hint: r.hint || '',
      discount: Number(r.discount) || 0,
      // all_modules — состав вычисляем на чтении, чтобы новые модули попадали в «Всё включено».
      modules: r.all_modules ? allModuleKeys() : (byId[r.id] || []),
      allModules: !!r.all_modules,
    }))
    _cache = { data: list, ts: Date.now() }
    return list
  } catch {
    // БД недоступна — не роняем витрину/списание: отдаём последний кэш или код-дефолт.
    return _cache?.data || SETUPS
  }
}

const newId = () => `set_${Math.random().toString(16).slice(2, 10)}`
const round = (v) => Math.min(0.9, Math.max(0, Math.round((Number(v) || 0) * 1000) / 1000))

/**
 * Создать/изменить сетап (админ). Валидация жёсткая: скидка 0..0.9, модули — только
 * известные (опечатка в ключе продавала бы несуществующий модуль).
 * @param {{id?:string,name?:string,hint?:string,discount?:number,modules?:string[],allModules?:boolean,sort?:number}} input
 */
export async function upsertSetup(input = {}) {
  const db = sb()
  if (!db) throw new Error('Редактирование сетапов доступно только на БД-бэкенде')
  const name = String(input.name || '').trim()
  if (!name) throw new Error('У сетапа должно быть имя — его увидит клиент')
  const allModules = !!input.allModules
  const modules = allModules ? [] : [...new Set((input.modules || []).map(String))]
  if (!allModules) {
    const unknown = modules.filter((k) => MODULE_MONTH_PRICE[k] === undefined)
    if (unknown.length) throw new Error(`Неизвестные модули: ${unknown.join(', ')}`)
    if (modules.length < 2) throw new Error('В сетапе должно быть минимум два модуля (иначе это не набор)')
  }
  const id = String(input.id || '').trim() || newId()
  const row = {
    id,
    name,
    hint: String(input.hint || '').trim(),
    discount: round(input.discount),
    all_modules: allModules,
    sort: Number.isFinite(Number(input.sort)) ? Math.round(Number(input.sort)) : 0,
    updated_at: new Date().toISOString(),
  }
  const { error } = await db.from('setups').upsert(row, { onConflict: 'id' })
  if (error) throw new Error(error.message)
  // Состав переписываем целиком: снять старые связи, поставить новые (кроме all_modules).
  await db.from('setup_modules').delete().eq('setup_id', id)
  if (!allModules && modules.length) {
    const { error: e2 } = await db.from('setup_modules').insert(modules.map((k) => ({ setup_id: id, module_key: k })))
    if (e2) throw new Error(e2.message)
  }
  invalidateSetups()
  return { id, name: row.name, hint: row.hint, discount: row.discount, modules: allModules ? allModuleKeys() : modules, allModules }
}

/** Удалить сетап. Уже купленные подписки не трогаем (у клиента остаётся его набор модулей). */
export async function deleteSetup(id) {
  const db = sb()
  if (!db) throw new Error('Редактирование сетапов доступно только на БД-бэкенде')
  const { data } = await db.from('setups').delete().eq('id', id).select('id') // setup_modules — по ON DELETE CASCADE
  invalidateSetups()
  return !!(data && data.length)
}
