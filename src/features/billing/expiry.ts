/**
 * Срок подписки на стороне интерфейса — зеркало серверного `subscriptionExpired`
 * (server/balance.js).
 *
 * Главное правило, которое нельзя нарушать нигде: `null`/`0`/`undefined` — это
 * БЕССРОЧНО (дефолтное пространство и демо без периода), а не «истекла вчера».
 * Ошибка в эту сторону закрывает доступ людям, которые всё оплатили.
 */
const DAY = 24 * 60 * 60 * 1000

/** Сколько дней до конца считается «вот-вот кончится» — тогда показываем предупреждение. */
export const EXPIRY_WARN_DAYS = 7

/** «19 сентября 2026» — дата для человека, без «г.» и без 19.09.2026-ребусов. */
export function formatExpiryDate(ts: number): string {
  return new Date(ts)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.?$/, '')
}

export interface ExpiryInfo {
  /** Срока нет — подписка бессрочная. Так и пишем словом, а не пустотой. */
  perpetual: boolean
  expired: boolean
  /** Дней до конца (округление вверх: «остался 1 день» до самой полуночи). */
  daysLeft: number
  /** Осталось меньше недели — пора предупредить, пока модули не отвалились. */
  soon: boolean
  /** Готовая подпись: «до 19 сентября 2026» / «истекла 3 августа 2026» / «бессрочно». */
  label: string
  date: string
}

export function expiryInfo(expiresAt?: number | null): ExpiryInfo {
  const ts = Number(expiresAt) || 0
  if (!ts) return { perpetual: true, expired: false, daysLeft: Infinity, soon: false, label: 'бессрочно', date: '' }
  const date = formatExpiryDate(ts)
  const expired = ts <= Date.now()
  const daysLeft = expired ? 0 : Math.ceil((ts - Date.now()) / DAY)
  return {
    perpetual: false,
    expired,
    daysLeft,
    soon: !expired && daysLeft <= EXPIRY_WARN_DAYS,
    label: expired ? `истекла ${date}` : `до ${date}`,
    date,
  }
}

/** «осталось 3 дня» — для предупреждения. Без дней склонять нечего. */
export function daysLeftPhrase(days: number): string {
  const m10 = days % 10
  const m100 = days % 100
  const word = m10 === 1 && m100 !== 11 ? 'день'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня'
      : 'дней'
  return `${days} ${word}`
}
