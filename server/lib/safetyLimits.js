/**
 * Safety-дефолты и бизнес-правила §6 (решение 15.07). Консервативные лимиты, чтобы не
 * ловить бан Telegram. Единый источник чисел — используется воркерами (дефолты) и Help Center.
 * ⚠️ Вся бизнес-логика продублирована в Help Center (src/shared/config/helpDocs.ts → 'safety-limits').
 */

/** Лимиты действий на 1 аккаунт в СУТКИ (§6). ЛС/вступления — высокий бан-риск. */
export const DAILY_LIMITS = {
  comments: { min: 20, max: 40 },
  dm: { min: 20, max: 30 }, // ЛС незнакомым — 🔴 высокий риск
  joins: { max: 20 }, // вступления в группы/каналы — 🔴 высокий риск
  reactions: { min: 100, max: 200 },
}

/** Диапазоны пауз между действиями, сек (умножаются на уровень защиты). */
export const PAUSE_RANGES = {
  default: [40, 180], // реакции/просмотры
  message: [60, 300], // сообщения/комментарии
  dm: [90, 300], // рассылка ЛС
}

/** Правила авто-стопа аккаунта (§3.3): жёсткие сигналы, без полной trust-формулы. */
export const AUTOSTOP = {
  floodWaitStreak: 3, // N FloodWait подряд → карантин
  hardStatuses: ['spamblock', 'quarantine', 'invalid', 'reauth'], // жёсткий стоп: не берём в работу
  mailingMinTrust: 70, // рассылку — только на аккаунты с высоким trust (когда появится trust)
}

/** Проверить, не превышен ли суточный лимит действия. @param {'comments'|'dm'|'joins'|'reactions'} action @param {number} count */
export function withinDailyLimit(action, count) {
  const lim = DAILY_LIMITS[action]
  if (!lim) return true
  return Number(count || 0) < (lim.max ?? Infinity)
}

/** Рекомендованный суточный потолок действия (max). @param {string} action */
export function dailyCap(action) {
  return DAILY_LIMITS[action]?.max ?? 0
}
