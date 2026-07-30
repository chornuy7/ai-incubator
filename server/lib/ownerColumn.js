/**
 * §11.3: владелец записи (`user_id`) — общий помощник для сторов.
 *
 * Со звонка 29.07: данные должны быть завязаны на юзера, который их создал, иначе
 * записи «висят в пустоте» и на вопрос «покажи всё, что делал этот человек» ответить
 * нечем (это же блокирует журнал активности, §11.1).
 *
 * Колонка добавляется миграцией `2026-07-30-owner-and-types.sql`. Пока её не применили,
 * писать в неё нельзя — PostgREST вернёт ошибку и уронит создание цели. Поэтому:
 *   • владельца ДУБЛИРУЕМ в jsonb `data` (там он лежит всегда, схема не нужна);
 *   • при вставке пробуем с колонкой, а на ошибку про неё — повторяем без неё;
 *   • при чтении берём колонку, а если её нет — значение из `data`.
 * Так одна и та же сборка работает и до, и после миграции.
 */

/** Ошибка PostgREST именно про отсутствующую колонку user_id (а не любая другая). */
function isMissingOwnerColumn(error) {
  const msg = String(error?.message || '')
  return /user_id/i.test(msg) && /(column|schema cache|does not exist|could not find)/i.test(msg)
}

/**
 * Вставка строки с владельцем и мягким откатом, если колонки ещё нет.
 * @param {any} db supabase-клиент
 * @param {string} table имя таблицы
 * @param {object} row строка (уже с user_id)
 */
export async function insertWithOwner(db, table, row) {
  const { error } = await db.from(table).insert(row)
  if (!error) return
  if (!isMissingOwnerColumn(error)) throw new Error(error.message)
  const { user_id: _omit, ...rest } = row
  void _omit
  const retry = await db.from(table).insert(rest)
  if (retry.error) throw new Error(retry.error.message)
  warnOnce(table)
}

/** Обновление с тем же откатом. */
export async function updateWithOwner(db, table, row, matchColumn, matchValue) {
  const { error } = await db.from(table).update(row).eq(matchColumn, matchValue)
  if (!error) return
  if (!isMissingOwnerColumn(error)) throw new Error(error.message)
  const { user_id: _omit, ...rest } = row
  void _omit
  const retry = await db.from(table).update(rest).eq(matchColumn, matchValue)
  if (retry.error) throw new Error(retry.error.message)
  warnOnce(table)
}

const warned = new Set()
function warnOnce(table) {
  if (warned.has(table)) return
  warned.add(table)
  console.warn(`[owner] в таблице ${table} нет колонки user_id — примените supabase/migrations/2026-07-30-owner-and-types.sql (владелец пока пишется только в data)`)
}

/** Владелец записи: колонка приоритетнее, дальше — дубль в jsonb. */
export function ownerOf(row) {
  return row?.user_id || row?.data?.userId || ''
}

/** Нормализуем id владельца из заголовка/тела: пустая строка → undefined. */
export function ownerFrom(req, body) {
  const id = String(body?.userId || req?.header?.('x-user-id') || '').trim()
  return id || undefined
}
