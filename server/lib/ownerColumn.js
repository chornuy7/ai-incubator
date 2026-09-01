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
 * FK-нарушение именно по владельцу: user_id ссылается на profiles(legacy_id) (§11.3),
 * но такого профиля нет — например, юзер завёлся в обход createUser и вошёл legacy-паролем.
 * Признак — код 23503 И упоминание user_id / owner-констрейнта (`*_user_profile_fkey`).
 * Чужие FK (campaign_id, goal_id и т.п.) НЕ глотаем — их роняем как раньше.
 */
function isOwnerFkViolation(error) {
  if (String(error?.code || '') !== '23503') return false
  const blob = `${error?.message || ''} ${error?.details || ''} ${error?.constraint || ''}`
  return /\buser_id\b/i.test(blob) || /user_profile_fkey/i.test(blob)
}

/** Причина отката без user_id: нет колонки / нет профиля-владельца. Иначе null. */
function ownerFallbackReason(error) {
  if (isMissingOwnerColumn(error)) return 'no-column'
  if (isOwnerFkViolation(error)) return 'no-profile'
  return null
}

/**
 * Вставка строки с владельцем и мягким откатом: если колонки ещё нет ИЛИ владелец без
 * профиля (FK) — повторяем без user_id, не роняя запись (владелец теряется, но данные
 * важнее 500-й — напр. авто-лид не должен валить переписку).
 * @param {any} db supabase-клиент
 * @param {string} table имя таблицы
 * @param {object} row строка (уже с user_id)
 */
export async function insertWithOwner(db, table, row) {
  const { error } = await db.from(table).insert(row)
  if (!error) return
  const reason = ownerFallbackReason(error)
  if (!reason) throw new Error(error.message)
  const { user_id: owner, ...rest } = row
  const retry = await db.from(table).insert(rest)
  if (retry.error) throw new Error(retry.error.message)
  warnOrphan(table, reason, owner)
}

/** Обновление с тем же откатом. */
export async function updateWithOwner(db, table, row, matchColumn, matchValue) {
  const { error } = await db.from(table).update(row).eq(matchColumn, matchValue)
  if (!error) return
  const reason = ownerFallbackReason(error)
  if (!reason) throw new Error(error.message)
  const { user_id: owner, ...rest } = row
  const retry = await db.from(table).update(rest).eq(matchColumn, matchValue)
  if (retry.error) throw new Error(retry.error.message)
  warnOrphan(table, reason, owner)
}

/**
 * Запись сохранена БЕЗ владельца — то есть в базе появилась сирота.
 *
 * Раньше об этом сообщалось `warnOnce`: одна строка на таблицу за весь запуск процесса.
 * Ровно наоборот тому, что нужно: первая сирота попадала в лог, а следующие двести — нет,
 * и по логу выходило, что случай единичный. Теперь пишем КАЖДЫЙ раз и называем владельца,
 * которого не нашли, — иначе непонятно, чей профиль заводить (MR-290).
 *
 * Строку всё-таки сохраняем, а не роняем запрос: авто-лид не должен валить переписку.
 * Но потеря атрибуции обязана быть видна — на неё заводят задачу, а не привыкают.
 * @param {string} table @param {'no-column'|'no-profile'} reason @param {string|undefined} owner
 */
function warnOrphan(table, reason, owner) {
  if (reason === 'no-profile') {
    console.warn(`[owner] ${table}: владельца ${owner || '(пусто)'} нет в profiles.legacy_id — строка сохранена БЕЗ user_id и стала ничьей. Заведите профиль, чтобы вернуть атрибуцию.`)
  } else {
    console.warn(`[owner] ${table}: нет колонки user_id — строка сохранена без владельца. Похоже, код уехал вперёд миграций: npm run migrate`)
  }
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
