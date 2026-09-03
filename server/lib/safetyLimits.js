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

/**
 * §12: защита прогрева и массовых действий. Прогрев — самый дорогой процесс:
 * случайный массовый стоп обнуляет недели работы, поэтому ставим отдельные барьеры.
 * Числа задаёт супер-админ (пока — дефолты здесь, единый источник для UI и воркеров).
 */
export const MASS_ACTION = {
  /** Со скольких задач массовый стоп требует усиленного подтверждения. */
  doubleConfirmFrom: 100,
  /** Прогрев можно останавливать/ставить на паузу только супер-админу. */
  warmingSuperAdminOnly: true,
}

/** Модули, которые считаем «прогревом» (их стоп защищён). */
export const WARMING_MODULES = new Set(['warming'])

/**
 * §12: сколько ступеней подтверждения нужно для массовой остановки. Чистая функция.
 * 1 — обычное подтверждение; 2 — усиленное («прочитал и уверен») при большом объёме.
 * @param {number} count @param {{doubleConfirmFrom?: number}} [limits]
 */
export function massStopConfirmSteps(count, limits = MASS_ACTION) {
  const n = Number(count) || 0
  if (n <= 0) return 0
  return n >= (limits.doubleConfirmFrom ?? 100) ? 2 : 1
}

/**
 * §12: можно ли этому пользователю останавливать/паузить прогрев. Чистая функция.
 * Прогрев защищён: без прав супер-админа — нельзя.
 * @param {boolean} isAdmin @param {{warmingSuperAdminOnly?: boolean}} [limits]
 */
export function canStopWarming(isAdmin, limits = MASS_ACTION) {
  return limits.warmingSuperAdminOnly === false ? true : !!isAdmin
}

/** §12: есть ли среди задач прогрев (его стоп требует особых прав). Чистая. */
export function containsWarming(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).some((t) => WARMING_MODULES.has(t?.moduleKey))
}
