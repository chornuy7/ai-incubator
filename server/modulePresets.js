/**
 * Шаблоны настроек модулей — в общей базе, а не в файлах на сервере.
 *
 * Находка 26.08 (вопрос владельца «почему у суб-аккаунта другой набор шаблонов»):
 * `taskStore` писал их в `server/data/modules/<модуль>/presets.json`, ветки Supabase не
 * было вовсе. Отсюда сразу три следствия:
 *   • локальная копия и сервер показывали РАЗНЫЕ наборы — сравнивать их было бессмысленно;
 *   • второй инстанс развёл бы шаблоны окончательно: у каждого свой файл;
 *   • это прямое нарушение правила «никаких локальных хранилищ, только общая база».
 *
 * ФОРМА ЗАПИСИ снаружи не изменилась: тот же массив объектов `{id, name, settings, userId,
 * createdAt, color, owner}`. Роуты и владельческий фильтр (`ownedForRequest`) работают как
 * раньше — здесь поменялось только место хранения.
 *
 * Файловый режим (без DATA_BACKEND=supabase) оставлен как у остальных сторов: локальный
 * запуск и тесты работают без базы.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Строка базы → объект, каким его ждут роуты и фронт. */
const fromRow = (r) => ({
  id: r.id,
  name: r.name,
  settings: r.settings ?? {},
  createdAt: Number(r.created_at) || 0,
  ...(r.user_id ? { userId: r.user_id } : {}),
  ...(r.color ? { color: r.color } : {}),
  ...(r.owner_label ? { owner: r.owner_label } : {}),
})

/** Объект из роутов → строка базы. */
const toRow = (moduleKey, p) => ({
  id: String(p.id),
  module_key: String(moduleKey),
  user_id: p.userId ? String(p.userId) : null,
  name: String(p.name ?? ''),
  color: p.color ? String(p.color).slice(0, 20) : null,
  owner_label: p.owner ? String(p.owner).slice(0, 40) : null,
  settings: p.settings ?? {},
  created_at: Number(p.createdAt) || Date.now(),
})

/**
 * Таблицы ещё нет (миграция не накатана) — не роняем модуль.
 * Ведём себя как пустой набор: показать нечего, но страница откроется.
 */
const isMissingTable = (error) =>
  !!error && /module_presets|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

/**
 * Все шаблоны модуля (без фильтра по владельцу — фильтрует вызывающий код).
 * @param {string} moduleKey
 * @param {() => Promise<object[]>} fileFallback чтение из файла для файлового режима
 * @returns {Promise<object[]>}
 */
export async function loadModulePresets(moduleKey, fileFallback) {
  const db = sb()
  if (!db) return fileFallback ? fileFallback() : []
  const { data, error } = await db
    .from('module_presets')
    .select('*')
    .eq('module_key', String(moduleKey))
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingTable(error)) return []
    throw new Error(`Не удалось прочитать шаблоны: ${error.message}`)
  }
  return (data || []).map(fromRow)
}

/**
 * Записать НАБОР шаблонов модуля целиком.
 *
 * Роуты собирают итоговый список сами (свои + чужие, дедуп по имени, потолок в 20 на
 * владельца) и отдают его сюда — поэтому запись «как есть»: чего в списке нет, того не
 * должно остаться и в базе.
 *
 * @param {string} moduleKey
 * @param {object[]} presets
 * @param {(list: object[]) => Promise<void>} fileFallback запись в файл для файлового режима
 */
export async function saveModulePresets(moduleKey, presets, fileFallback) {
  const list = Array.isArray(presets) ? presets : []
  const db = sb()
  if (!db) return fileFallback ? fileFallback(list) : undefined

  const rows = list.filter((p) => p && p.id).map((p) => toRow(moduleKey, p))
  const keep = rows.map((r) => r.id)
  // Сначала убираем то, чего в новом списке нет, потом пишем сам список. Порядок важен:
  // удаление по «id НЕ входит в набор» после upsert снесло бы только что записанное,
  // если бы набор пришёл пустым.
  const del = db.from('module_presets').delete().eq('module_key', String(moduleKey))
  const { error: delErr } = keep.length ? await del.not('id', 'in', `(${keep.map((id) => `"${id}"`).join(',')})`) : await del
  if (delErr && !isMissingTable(delErr)) throw new Error(`Не удалось обновить шаблоны: ${delErr.message}`)

  if (!rows.length) return
  const { error } = await db.from('module_presets').upsert(rows, { onConflict: 'id' })
  if (error && !isMissingTable(error)) throw new Error(`Не удалось сохранить шаблоны: ${error.message}`)
}

/*
 * Переноса файловых шаблонов здесь нет намеренно — он живёт отдельным скриптом
 * `server/scripts/presets-to-db.mjs` и запускается руками на сервере.
 *
 * Автоперенос при первом чтении выглядел удобнее, но был опасен: локальные копии
 * разработчиков ходят в ту же боевую базу, а файлы шаблонов у всех разные. Выигрывал бы
 * тот, чья копия прочитала первой — его шаблоны уехали бы в прод, а настоящие серверные
 * уже нет, потому что таблица непустая и перенос считается выполненным.
 */
