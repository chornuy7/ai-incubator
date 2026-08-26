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
 * АВТОПЕРЕНОСА при первом чтении здесь нет намеренно. Он выглядел удобнее, но был опасен:
 * локальные копии разработчиков ходят в ту же боевую базу, а файлы шаблонов у всех разные.
 * Выигрывал бы тот, чья копия прочитала первой — его шаблоны уехали бы в прод, а настоящие
 * серверные уже нет, потому что таблица непустая и перенос считается выполненным.
 *
 * Поэтому перенос — осознанное действие. Логика ниже общая для двух точек входа:
 * скрипта `server/scripts/presets-to-db.mjs` (на сервере) и ручки админки
 * `POST /api/admin/presets-to-db` (когда SSH нет, а файлы читает сам серверный процесс).
 */

/** Где лежат файлы шаблонов: общий стор модулей + отдельный каталог нейрокомментинга. */
async function presetFileSources() {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { DATA_DIR } = await import('./lib/jsonStore.js')
  const out = []
  const modulesDir = path.join(DATA_DIR, 'modules')
  const dirs = await fs.readdir(modulesDir, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (d.isDirectory()) out.push({ moduleKey: d.name, file: path.join(modulesDir, d.name, 'presets.json') })
  }
  // Нейрокомментинг исторически живёт в своём каталоге, а не в modules/.
  out.push({ moduleKey: 'neuro-commenting', file: path.join(DATA_DIR, 'neuro-commenting', 'presets.json') })
  return out
}

/**
 * Перенести шаблоны из файлов сервера в базу.
 *
 * @param {{ apply?: boolean }} [opts] apply=false (по умолчанию) — только показать, что
 *   будет перенесено, ничего не записывая.
 * @returns {Promise<{ moved: number, items: Array<{moduleKey:string, count:number, names:string[], skipped?:boolean, error?:string}> }>}
 */
export async function migratePresetFilesToDb({ apply = false } = {}) {
  const fs = await import('node:fs/promises')
  const readFile = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return [] }
  }

  const items = []
  let moved = 0
  for (const { moduleKey, file } of await presetFileSources()) {
    const fromFile = await readFile(file)
    if (!Array.isArray(fromFile) || !fromFile.length) continue

    let inDb
    try { inDb = await loadModulePresets(moduleKey) } catch (e) {
      items.push({ moduleKey, count: 0, names: [], error: e instanceof Error ? e.message : 'ошибка чтения базы' })
      continue
    }
    // Модуль, где в базе уже что-то есть, не трогаем: повторный запуск не должен
    // воскрешать удалённое и плодить дубли.
    if (inDb.length) {
      items.push({ moduleKey, count: inDb.length, names: [], skipped: true })
      continue
    }

    const names = fromFile.map((p) => String(p?.name ?? '')).filter(Boolean)
    if (!apply) {
      items.push({ moduleKey, count: fromFile.length, names })
      moved += fromFile.length
      continue
    }
    await saveModulePresets(moduleKey, fromFile)
    const check = await loadModulePresets(moduleKey)
    items.push({ moduleKey, count: check.length, names })
    moved += check.length
  }
  return { moved, items }
}
