/**
 * MR-290: перевод времени между базой и кодом.
 *
 * В базе момент времени — `timestamptz`. В коде — миллисекунды с эпохи: так его считает
 * `Date.now()`, так его ждут воркеры, так он уезжает в интерфейс. Раньше миллисекунды
 * лежали и в базе, колонками `bigint`, и это стоило дорого: по такой колонке нельзя
 * спросить «за прошлую неделю» без ручного пересчёта, в Table Editor вместо даты видно
 * `1787588909052`, а часовой пояс не хранится вовсе — число это UTC по договорённости,
 * которая нигде не записана.
 *
 * Перевод собран в одном месте намеренно. Он выглядит однострочным, но в нём три ловушки,
 * и каждая уже стоила нам ошибки:
 *
 *   1. НОЛЬ — ЭТО НЕ ДАТА. В части колонок 0 означал «никогда»: аккаунт не отдыхает,
 *      обращение не читали. Пропустив это, получаем «отдыхает до 01.01.1970».
 *   2. NULL И НОЛЬ РАЗЛИЧАЮТСЯ ПО МЕСТУ. Одни вызывающие ждут `0` («ничего не было»),
 *      другие — `null` («не запланировано»). Поэтому чтений два, и выбирает вызывающий.
 *   3. NaN ТИХО СТАНОВИТСЯ ДАТОЙ. `new Date(NaN).toISOString()` бросает, а `Number('')`
 *      даёт NaN — так что мусор на входе обязан превращаться в NULL, а не в исключение
 *      посреди сохранения.
 */

/**
 * Момент → значение колонки. Ноль, пусто и мусор дают NULL: «никогда» и «начало эпохи» —
 * разные вещи, и в базе они должны выглядеть по-разному.
 * @param {number|string|Date|null|undefined} ms
 * @returns {string|null} ISO-строка для timestamptz
 */
export function toDbTime(ms) {
  if (ms == null || ms === '' || ms === 0) return null
  const n = ms instanceof Date ? ms.getTime() : Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n).toISOString()
}

/**
 * Разбор значения из хранилища.
 *
 * Принимает ОБА представления намеренно: Postgres отдаёт ISO-строку, а запасной SQLite
 * (кэш парсера, витрина оплат) — по-прежнему число. Одна функция на оба избавляет от
 * ветвлений в каждом сторе.
 *
 * Числовая СТРОКА разбирается отдельно: `new Date('1787588909052')` даёт Invalid Date,
 * потому что строку JS пытается прочитать как дату, а не как число. Драйверы иногда
 * отдают bigint именно строкой — на этом легко потерять всё время разом.
 * @param {string|number|Date|null|undefined} v @returns {number|null}
 */
function parseDbTime(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  const s = String(v)
  if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) && n > 0 ? n : null }
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Значение колонки → миллисекунды, где «нет времени» это НОЛЬ.
 * Для вызывающих, которые исторически писали `Number(r.col) || 0`.
 * @param {string|number|Date|null|undefined} v @returns {number}
 */
export function fromDbTime(v) {
  return parseDbTime(v) ?? 0
}

/**
 * Значение колонки → миллисекунды, где «нет времени» это NULL.
 * Для вызывающих, которые отличают «не запланировано» от «в начале эпохи».
 * @param {string|number|Date|null|undefined} v @returns {number|null}
 */
export function fromDbTimeOrNull(v) {
  return parseDbTime(v)
}
