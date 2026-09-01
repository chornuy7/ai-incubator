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
 * authorId, createdAt, color, owner}`. Роуты и владельческий фильтр (`ownedForRequest`) работают как
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
  // MR-196: автор — человек. `user_id` рядом — это пространство, у админа и его
  // сотрудника оно одно, и различить их по нему нельзя.
  ...(r.author_id ? { authorId: r.author_id } : {}),
  ...(r.color ? { color: r.color } : {}),
  ...(r.owner_label ? { owner: r.owner_label } : {}),
})

/** Объект из роутов → строка базы. */
const toRow = (moduleKey, p) => ({
  id: String(p.id),
  module_key: String(moduleKey),
  user_id: p.userId ? String(p.userId) : null,
  author_id: p.authorId ? String(p.authorId) : null,
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
const isMissingTable = (error) => {
  if (!error) return false
  const msg = String(error.message || '')
  const code = String(error.code || '')
  /*
   * Отличать отсутствующую ТАБЛИЦУ от отсутствующей КОЛОНКИ обязательно, хотя PostgREST
   * пишет про «schema cache» в обоих случаях.
   *
   * Прежнее правило ловило и то и другое, а вызывающий код на «таблицы нет» молчит и идёт
   * дальше. Поймано на MR-196: добавили колонку `author_id`, база её ещё не знала — запись
   * шаблона провалилась, а роут ответил `ok: true`. Шаблон исчез без единого следа, и
   * узнать об этом можно было только перечитав список.
   *
   * Таблицы нет — это разворачивание с нуля, и молчать там уместно: страница откроется
   * пустой. Колонки нет — это несовпадение кода и схемы, то есть авария выкатки: о ней
   * надо кричать, а не терять данные.
   */
  if (/could not find the '[^']+' column/i.test(msg) || code === 'PGRST204') return false
  return /could not find the table/i.test(msg)
    || /relation .* does not exist/i.test(msg)
    || code === '42P01'
    || code === 'PGRST205'
}

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
  await upsertPresets(db, rows)
}

/**
 * Записать строки, пережив базу, которая ещё не знает новую колонку.
 *
 * Так уже сделано в журнале кошелька (`appendWalletEntry`): миграции доезжают до базы
 * отдельно от кода, и между выкатами колонки может не быть. Ронять из-за этого сохранение
 * нельзя — человек потеряет собранные настройки на ровном месте; но и молчать нельзя —
 * именно молчание съело шаблон при проверке MR-196.
 *
 * Поэтому: не знает колонку — пишем без неё и говорим об этом в лог. Запись доезжает
 * целой, теряется только новое поле, и ровно до тех пор, пока не накатится миграция.
 */
async function upsertPresets(db, rows, глубина = 0) {
  const { error } = await db.from('module_presets').upsert(rows, { onConflict: 'id' })
  if (!error) return
  if (isMissingTable(error)) return

  const колонка = /could not find the '([^']+)' column/i.exec(String(error.message || ''))?.[1]
  // Глубина ограничена: колонок в строке конечное число, но ошибка базы может и повторяться,
  // а бесконечная рекурсия по чужому ответу — худший способ это заметить.
  if (колонка && глубина < 5 && rows.some((r) => колонка in r)) {
    console.warn(`[presets] база не знает колонку «${колонка}» — сохраняю без неё; накатите миграции`)
    return upsertPresets(db, rows.map(({ [колонка]: _пропускаем, ...остальное }) => остальное), глубина + 1)
  }
  throw new Error(`Не удалось сохранить шаблоны: ${error.message}`)
}

/*
 * АВТОПЕРЕНОСА при первом чтении здесь нет намеренно. Он выглядел удобнее, но был опасен:
 * локальные копии разработчиков ходят в ту же боевую базу, а файлы шаблонов у всех разные.
 * Выигрывал бы тот, чья копия прочитала первой — его шаблоны уехали бы в прод, а настоящие
 * серверные уже нет, потому что таблица непустая и перенос считается выполненным.
 *
 * Старые файловые шаблоны переносить не стали (решение владельца 27.08): их бросили,
 * новые заводятся сразу в базе. Файл ниже остаётся только фолбэком для запуска без базы.
 */
