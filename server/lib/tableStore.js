/**
 * §10.2: помощники «список/словарь поверх таблицы».
 *
 * Оставшиеся сторы (группы аккаунтов, расписания, агенты, усталость) исторически
 * работают со ВСЕЙ коллекцией: прочитал → изменил → записал. Переписывать их логику
 * на точечные запросы значило бы трогать бизнес-правила ради формы хранения, поэтому
 * здесь адаптер с той же семантикой, но поверх БД.
 *
 * Коллекции маленькие (единицы-десятки записей), пишутся редко — цена «перезаписать
 * всё» здесь пренебрежима, а риск сломать логику при переписывании — нет.
 *
 * Без DATA_BACKEND=supabase (тесты, локальный запуск) всё работает по файлам, как раньше.
 * Если таблицы ещё нет (миграция не применена) — тоже падаем на файл, а не роняем модуль.
 */
import { getSupabase, supabaseEnabled } from './supabase.js'
import { readJson, writeJson } from './jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const val = (f) => (typeof f === 'function' ? f() : f)

/**
 * Цепочки сериализации по таблице — как в `mutateJson` для файлов.
 *
 * Без этого read-modify-write параллельных воркеров затирал бы друг друга: два
 * одновременных обновления усталости прочитали бы одно и то же состояние и записали
 * бы каждый своё. Именно от этой болезни и защищался файловый вариант.
 */
const _chains = new Map()
function serialize(table, fn) {
  const prev = _chains.get(table) || Promise.resolve()
  const run = prev.then(fn)
  // В цепочке держим версию, которая не реджектит: одна ошибка не должна
  // заблокировать все последующие операции над таблицей.
  _chains.set(table, run.catch(() => {}))
  return run
}

/**
 * Коллекция-СПИСОК поверх таблицы с текстовым `id`.
 * @param {{table:string, file:string|(()=>string), toRow:(o:any)=>any, fromRow:(r:any)=>any, order?:string}} cfg
 */
export function listStore(cfg) {
  const { table, file, toRow, fromRow, order = 'created_at' } = cfg

  async function readAll() {
    const db = sb()
    if (!db) return readJson(val(file), [])
    const { data, error } = await db.from(table).select('*').order(order, { ascending: false })
    if (error) return readJson(val(file), [])
    return (data || []).map(fromRow)
  }

  async function writeAll(all) {
    const db = sb()
    if (!db) return writeJson(val(file), all)
    const rows = (all || []).map(toRow)
    if (rows.length) {
      const { error } = await db.from(table).upsert(rows, { onConflict: 'id' })
      if (error) { console.warn(`[${table}] запись в БД не удалась: ${error.message}`); return writeJson(val(file), all) }
    }
    // Удалённые записи: чего нет в коллекции — нет и в таблице.
    const { data: existing } = await db.from(table).select('id')
    const keep = new Set(rows.map((r) => r.id))
    const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(id))
    if (gone.length) await db.from(table).delete().in('id', gone)
    return all
  }

  /** Прочитать → применить мутатор → записать. Сериализовано по таблице. */
  function mutate(fn) {
    return serialize(table, async () => {
      const all = await readAll()
      const next = await fn(all)
      if (next === undefined) return all // мутатор отказался менять — не трогаем хранилище
      await writeAll(next)
      return next
    })
  }

  return { readAll, writeAll, mutate }
}

/**
 * Коллекция-СЛОВАРЬ (ключ → объект) поверх таблицы с колонкой-ключом.
 * @param {{table:string, file:string|(()=>string), keyCol:string, toRow:(k:string,o:any)=>any, fromRow:(r:any)=>[string,any]}} cfg
 */
export function mapStore(cfg) {
  const { table, file, keyCol, toRow, fromRow } = cfg

  async function readAll() {
    const db = sb()
    if (!db) return readJson(val(file), {})
    const { data, error } = await db.from(table).select('*')
    if (error) return readJson(val(file), {})
    const out = {}
    for (const r of data || []) { const [k, v] = fromRow(r); out[k] = v }
    return out
  }

  async function writeAll(all) {
    const db = sb()
    if (!db) return writeJson(val(file), all)
    const rows = Object.entries(all || {}).map(([k, v]) => toRow(k, v))
    if (rows.length) {
      const { error } = await db.from(table).upsert(rows, { onConflict: keyCol })
      if (error) { console.warn(`[${table}] запись в БД не удалась: ${error.message}`); return writeJson(val(file), all) }
    }
    const { data: existing } = await db.from(table).select(keyCol)
    const keep = new Set(rows.map((r) => r[keyCol]))
    const gone = (existing || []).map((r) => r[keyCol]).filter((k) => !keep.has(k))
    if (gone.length) await db.from(table).delete().in(keyCol, gone)
    return all
  }

  function mutate(fn) {
    return serialize(table, async () => {
      const all = await readAll()
      const next = await fn(all)
      if (next === undefined) return all
      await writeAll(next)
      return next
    })
  }

  return { readAll, writeAll, mutate }
}
