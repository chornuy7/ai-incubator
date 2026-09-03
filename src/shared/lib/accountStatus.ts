import type { TgAccount, AccountStatus } from '@/shared/types'

/**
 * Статусы, при которых аккаунт нельзя брать в работу (§3.2/§5.1): непрогретые, на паузе,
 * в карантине/спамблоке/FloodWait, требующие авторизации, невалидные, замороженные.
 * Тот же список, что в `AccountPicker` — держим единым, чтобы пул кампании и пикер модуля
 * не расходились в том, кого считать «свободным».
 */
export const NON_RUNNABLE_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>([
  'warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid', 'frozen',
])

/**
 * Аккаунт свободен для работы: не занят задачей (`busyIn`), не в статусе `working`
 * и статус не из «нерабочих». Именно таких показываем в пуле кампании — заливать
 * в кампанию спамблок/карантин/занятый смысла нет.
 */
export function isAvailableForWork(a: TgAccount): boolean {
  return !a.busyIn && a.status !== 'working' && !NON_RUNNABLE_STATUSES.has(a.status)
}
