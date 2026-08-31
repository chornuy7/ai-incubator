/**
 * Цикл подписки — КАЛЕНДАРНЫЙ месяц, привязанный ко дню оплаты.
 *
 * Заказчик 31.08: «списання раз в місяць і в той день, коли саме у нас було оформлення
 * підписки, а не рівно 30 днів. Повинно бути 12 циклів».
 *
 * До этого срок двигался на фиксированные 30 суток. Из-за этого дата платежа сползала
 * назад примерно на пять дней в год (12 циклов = 360 дней), и раз в шесть лет с человека
 * списывали тринадцатый раз за календарный год. Оформил 31 августа — платил 30 сентября,
 * 30 октября, 29 ноября, 29 декабря, 28 января.
 *
 * КОРОТКИЕ МЕСЯЦЫ. Оформили 31 января — 31 февраля не существует, списываем 28-го (29-го
 * в високосный). Но день оплаты при этом остаётся 31-м: считать следующий цикл от 28
 * февраля нельзя, иначе после одного февраля подписка навсегда переезжает на 28 число, а
 * за ним — на 28 в каждом следующем месяце. Поэтому день берётся из подписки
 * (`subscriptions.billing_day`), а не из даты прошлого списания.
 */

/** Сколько дней в месяце (месяц с нуля, как в Date). */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * Тот же день в ЭТОМ месяце — момент, начиная с которого цикл считается наступившим.
 *
 * @param {number} nowMs любой момент внутри нужного месяца
 * @param {number} billingDay день оплаты (1..31)
 * @returns {number}
 */
export function cycleMomentIn(nowMs, billingDay) {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const день = Math.min(Math.max(Number(billingDay) || 1, 1), daysInMonth(y, m))
  return Date.UTC(y, m, день)
}

/**
 * Следующий цикл после `fromMs` — то же число СЛЕДУЮЩЕГО календарного месяца.
 *
 * Время суток сохраняем: подписка, оплаченная в 23:50, не должна на следующем цикле
 * истечь в полночь и на десять минут оставить человека без модулей.
 *
 * @param {number} fromMs от какого момента считаем
 * @param {number} [billingDay] день оплаты; без него берём день из самой даты
 * @returns {number}
 */
export function nextCycle(fromMs, billingDay) {
  const d = new Date(fromMs)
  const день = Number(billingDay) || d.getUTCDate()
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const влезет = Math.min(день, daysInMonth(y, m + 1))
  return Date.UTC(y, m + 1, влезет, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
}

/** День оплаты по дате — когда в подписке он ещё не проставлен. */
export function billingDayOf(ms) {
  return new Date(ms).getUTCDate()
}
