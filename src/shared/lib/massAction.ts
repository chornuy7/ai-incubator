/**
 * §12: защита прогрева и массовых действий. Зеркало server/lib/safetyLimits.js —
 * прогрев дороже всего (недели работы), поэтому его стоп защищён отдельно.
 */

export const MASS_ACTION = {
  /** Со скольких задач массовый стоп требует усиленного подтверждения. */
  doubleConfirmFrom: 100,
  /** Прогрев останавливает только супер-админ. */
  warmingSuperAdminOnly: true,
}

/** Модули, считающиеся «прогревом». */
export const WARMING_MODULES = new Set(['warming'])

/** Сколько ступеней подтверждения нужно: 1 — обычное, 2 — усиленное. */
export function massStopConfirmSteps(count: number, limits = MASS_ACTION): number {
  const n = Number(count) || 0
  if (n <= 0) return 0
  return n >= limits.doubleConfirmFrom ? 2 : 1
}

/** Можно ли пользователю останавливать/паузить прогрев. */
export function canStopWarming(isAdmin: boolean, limits = MASS_ACTION): boolean {
  return limits.warmingSuperAdminOnly === false ? true : !!isAdmin
}

/** Есть ли среди задач прогрев. */
export function containsWarming(tasks: { moduleKey: string }[]): boolean {
  return tasks.some((t) => WARMING_MODULES.has(t.moduleKey))
}
