/**
 * §5.4: наборы модулей, которые админ собирает САМ — под конкретного клиента.
 *
 * Встроенные сетапы («Аутрич», «Вовлечение») зашиты в pricing.js и покрывают
 * типовые сценарии. Но продажа выглядит иначе: клиенту нужен «парсер групп +
 * нейрокомментинг за 20 $» — админ собирает ровно этот пакет, называет цену,
 * и покупатель получает ровно эти модули. Токены и монеты за работу — сверх,
 * как и везде.
 *
 * Цена ЯВНАЯ, а не скидкой: админ продаёт за названную сумму, а не за «минус N %
 * от прайса» — прайс поменяется, а договорённость с клиентом останется.
 *
 * Хранение — data/bundles.json; путь через env BUNDLES_FILE (изоляция тестов).
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { MODULE_MONTH_PRICE } from './pricing.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const rowToBundle = (r) => ({ id: r.id, name: r.name, hint: r.hint || '', modules: r.modules || [], price: Number(r.price), createdAt: r.created_at ? new Date(r.created_at).getTime() : 0 })

/**
 * Состав наборов из таблицы связей: bundle_id → ключи модулей.
 * Пустой набор в ответе не появляется — если строк нет, вызывающий оставит JSON-состав.
 */
async function modulesByBundle(db, ids) {
  const out = new Map()
  if (!ids.length) return out
  const { data: links, error } = await db.from('bundle_modules').select('bundle_id, module_id').in('bundle_id', ids)
  if (error || !links?.length) return out
  const { data: mods } = await db.from('modules').select('id, key')
  const keyById = new Map((mods || []).map((m) => [String(m.id), m.key]))
  for (const l of links) {
    const key = keyById.get(String(l.module_id))
    if (!key) continue
    if (!out.has(l.bundle_id)) out.set(l.bundle_id, [])
    out.get(l.bundle_id).push(key)
  }
  return out
}

const BUNDLES_FILE = () => process.env.BUNDLES_FILE || dataPath('bundles.json')

const newId = () => `bun_${Math.random().toString(16).slice(2, 10)}`

/** @returns {Promise<Array<{id:string,name:string,hint:string,modules:string[],price:number,createdAt:number}>>} */
export async function listBundles() {
  const db = sb()
  if (db) {
    const { data } = await db.from('bundles').select('*').order('created_at', { ascending: true })
    const list = (data || []).map(rowToBundle)
    /*
     * MR-190: состав набора — из таблицы связей `bundle_modules`, а не из JSON-колонки.
     *
     * Одно и то же хранилось дважды: колонка `bundles.modules` и строки `bundle_modules`.
     * Пока источников два, они однажды разъедутся, и клиент купит набор с одним составом,
     * а получит другой. Источник правды — таблица связей.
     *
     * JSON остаётся запасным путём ровно до тех пор, пока колонку не снимут миграцией:
     * между выкатом кода и миграцией у набора должен быть состав в любом случае.
     */
    const состав = await modulesByBundle(db, list.map((b) => b.id))
    return list.map((b) => (состав.has(b.id) ? { ...b, modules: состав.get(b.id) } : b))
  }
  const raw = await readJson(BUNDLES_FILE(), [])
  return Array.isArray(raw) ? raw : []
}

/**
 * Создать набор. Валидация жёсткая: набор с опечаткой в ключе модуля молча
 * продавал бы воздух — модуль «parsing-grups» никогда не откроется.
 * @param {{name?:string, hint?:string, modules?:string[], price?:number}} input
 */
export async function createBundle(input = {}) {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('У набора должно быть имя — его увидит клиент')

  const modules = [...new Set((input.modules || []).map(String))]
  const unknown = modules.filter((k) => MODULE_MONTH_PRICE[k] === undefined)
  if (unknown.length) throw new Error(`Неизвестные модули: ${unknown.join(', ')}`)
  if (modules.length < 1) throw new Error('Выберите хотя бы один модуль')

  const price = Math.round((Number(input.price) || 0) * 100) / 100
  if (price <= 0) throw new Error('Цена набора должна быть больше нуля')

  const bundle = {
    id: newId(),
    name,
    hint: String(input.hint || '').trim(),
    modules,
    price,
    createdAt: Date.now(),
  }
  const db = sb()
  if (db) {
    // Наборы ГЛОБАЛЬНЫЕ: их собирает админ, видят все (listBundles не фильтрует по владельцу,
    // rowToBundle владельца не читает). Поэтому owner-колонки тут нет — она была мёртвой
    // (писалась, но нигде не использовалась). Кто создал набор — фиксирует audit_log
    // (bundle.create, initiator). Колонка user_id удалена миграцией 2026-08-19-bundles-drop-user-id.sql.
    const { error } = await db.from('bundles').insert({
      id: bundle.id, name: bundle.name, hint: bundle.hint, modules: bundle.modules,
      price: bundle.price, created_at: new Date(bundle.createdAt).toISOString(),
    })
    if (error) throw new Error(error.message)
    /*
     * Связи пишем СРАЗУ, а не ждём фоновой синхронизации.
     *
     * Раньше строки bundle_modules появлялись только когда typesSync перестраивал их из
     * JSON-колонки. Теперь состав читается из связей (listBundles), поэтому набор, созданный
     * между двумя синхронизациями, выглядел бы пустым. И это же развязывает руки миграции:
     * снять JSON-колонку можно, не сломав создание.
     */
    const { data: mods } = await db.from('modules').select('id, key')
    const idByKey = new Map((mods || []).map((m) => [m.key, m.id]))
    const links = bundle.modules.map((k) => idByKey.get(k)).filter((v) => v != null).map((module_id) => ({ bundle_id: bundle.id, module_id }))
    if (links.length) await db.from('bundle_modules').insert(links)
    return bundle
  }
  // mutateJson, а не read+write: он сериализует запись в файл (очередь _fileChains).
  // Два одновременных createBundle через writeJson затирали бы друг друга — набор терялся.
  await mutateJson(BUNDLES_FILE(), (raw) => {
    const list = Array.isArray(raw) ? raw : []
    return [...list, bundle]
  }, [])
  return bundle
}

/** Удалить набор. Уже проданные подписки не трогаем: у клиента остаётся его список модулей. */
export async function deleteBundle(id) {
  const db = sb()
  if (db) {
    // Связи сносим первыми: иначе они останутся сиротами и всплывут в следующем аудите.
    await db.from('bundle_modules').delete().eq('bundle_id', id)
    const { data } = await db.from('bundles').delete().eq('id', id).select('id')
    return !!(data && data.length)
  }
  let removed = false
  await mutateJson(BUNDLES_FILE(), (raw) => {
    const list = Array.isArray(raw) ? raw : []
    const next = list.filter((b) => b.id !== id)
    removed = next.length !== list.length
    return next
  }, [])
  return removed
}
