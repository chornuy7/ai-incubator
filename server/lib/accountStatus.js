/**
 * Централизованная state machine статусов аккаунта (Lane A, Фаза 1).
 * Кодирует контракт из docs/CONTRACT-account-state-machine.md.
 *
 * Статус ортогонален локу: статус отвечает «можно ли вообще брать аккаунт»,
 * лок (accountLocks.js) — «занят ли он прямо сейчас конкретной задачей».
 * Модуль чистый (без побочных эффектов и I/O) — целиком юнит-тестируется.
 */

/** Канонический набор статусов жизненного цикла (ТЗ §3.3). */
export const STATUS = {
  ACTIVE: 'active',
  WARMING: 'warming',
  PAUSE: 'pause',
  FLOODWAIT: 'floodwait',
  QUARANTINE: 'quarantine',
  SPAMBLOCK: 'spamblock',
  REAUTH: 'reauth',
  INVALID: 'invalid',
}

/** @type {string[]} */
export const ALL_STATUSES = Object.values(STATUS)

/**
 * Legacy-статусы из уже существующих данных/кода → канонический набор.
 * `working` — это факт занятости задачей (лок), а не статус жизненного цикла.
 * `frozen` — 🔒 §6 (пока трактуем как карантин; развести — TODO).
 * @type {Record<string, string>}
 */
const LEGACY_MAP = {
  working: STATUS.ACTIVE,
  frozen: STATUS.QUARANTINE,
  valid: STATUS.ACTIVE,
  none: STATUS.ACTIVE,
  '': STATUS.ACTIVE,
}

/** Привести любой сохранённый статус к каноническому. @param {string|undefined|null} status */
export function normalizeStatus(status) {
  if (!status) return STATUS.ACTIVE
  const s = String(status).toLowerCase()
  if (ALL_STATUSES.includes(s)) return s
  if (s in LEGACY_MAP) return LEGACY_MAP[s]
  return STATUS.ACTIVE
}

/** Статусы, в которых аккаунт НЕ берётся рабочими модулями. */
const NON_RUNNABLE = new Set([
  STATUS.WARMING,
  STATUS.PAUSE,
  STATUS.FLOODWAIT,
  STATUS.QUARANTINE,
  STATUS.SPAMBLOCK,
  STATUS.REAUTH,
  STATUS.INVALID,
])

/** Можно ли запускать воркер на аккаунте в этом статусе. @param {string} status */
export function isRunnable(status) {
  return !NON_RUNNABLE.has(normalizeStatus(status))
}

/**
 * Можно ли назначить аккаунт в рабочий модуль (ручно/оркестратором).
 * Совпадает с isRunnable; исключение «горячий лид» для warming обрабатывает вызывающий.
 * @param {string} status
 */
export function canAssign(status) {
  return isRunnable(status)
}

/** Терминальные статусы (выход только ручным удалением/переавторизацией). */
export const TERMINAL = new Set([STATUS.INVALID])

/**
 * Разрешённые переходы: источник → допустимые цели.
 * Соответствует таблице переходов в CONTRACT-account-state-machine.md §5.
 * @type {Record<string, string[]>}
 */
const TRANSITIONS = {
  active: [STATUS.WARMING, STATUS.PAUSE, STATUS.FLOODWAIT, STATUS.SPAMBLOCK, STATUS.INVALID, STATUS.QUARANTINE, STATUS.REAUTH],
  warming: [STATUS.ACTIVE, STATUS.PAUSE, STATUS.QUARANTINE, STATUS.INVALID, STATUS.REAUTH, STATUS.FLOODWAIT, STATUS.SPAMBLOCK],
  pause: [STATUS.ACTIVE],
  floodwait: [STATUS.ACTIVE, STATUS.QUARANTINE, STATUS.WARMING, STATUS.PAUSE, STATUS.INVALID, STATUS.REAUTH, STATUS.SPAMBLOCK],
  quarantine: [STATUS.ACTIVE, STATUS.WARMING, STATUS.INVALID, STATUS.PAUSE, STATUS.REAUTH],
  spamblock: [STATUS.QUARANTINE, STATUS.ACTIVE, STATUS.INVALID, STATUS.PAUSE, STATUS.REAUTH],
  reauth: [STATUS.ACTIVE, STATUS.INVALID],
  invalid: [],
}

/** Разрешён ли переход from→to (тождественный переход разрешён). @param {string} from @param {string} to */
export function canTransition(from, to) {
  const f = normalizeStatus(from)
  const t = normalizeStatus(to)
  if (f === t) return true
  return (TRANSITIONS[f] || []).includes(t)
}

/**
 * Собрать патч meta для смены статуса (НЕ сохраняет — сохраняет вызывающий через setAccountMeta).
 * Бросает ILLEGAL_TRANSITION при недопустимом переходе.
 * @param {{ status?: string }} currentMeta
 * @param {string} to
 * @param {{ reason?: string, code?: string, until?: number|null, initiator?: string }} [opts]
 * @returns {{ status: string, statusReason: string, statusCode: string, statusSince: number, statusUntil: number|null, statusBy: string, prevStatus: string }}
 */
export function buildStatusPatch(currentMeta, to, opts = {}) {
  const from = normalizeStatus(currentMeta?.status)
  const target = normalizeStatus(to)
  if (!canTransition(from, target)) {
    throw new Error(`ILLEGAL_TRANSITION:${from}->${target}`)
  }
  const { reason = '', code = '', until = null, initiator = 'system' } = opts
  return {
    status: target,
    statusReason: reason || code || '',
    statusCode: code || '',
    statusSince: Date.now(),
    statusUntil: until,
    statusBy: initiator || 'system',
    prevStatus: from,
  }
}

/**
 * Истёк ли временный статус (floodwait/quarantine с statusUntil).
 * @param {{ status?: string, statusUntil?: number|null }} meta
 * @param {number} [now]
 */
export function isStatusExpired(meta, now = Date.now()) {
  const s = normalizeStatus(meta?.status)
  if (s !== STATUS.FLOODWAIT && s !== STATUS.QUARANTINE) return false
  return typeof meta?.statusUntil === 'number' && meta.statusUntil > 0 && now >= meta.statusUntil
}

/**
 * Куда вернуть аккаунт после истечения временного статуса, или null если не пора.
 * floodwait → prevStatus (если рабочий, иначе active).
 * quarantine → warming (🔒 §6: авто-возврат по trust не определён — по таймеру не в active сразу, а на перепрогрев).
 * @param {{ status?: string, statusUntil?: number|null, prevStatus?: string }} meta
 * @param {number} [now]
 * @returns {string|null}
 */
export function nextStatusAfterExpiry(meta, now = Date.now()) {
  if (!isStatusExpired(meta, now)) return null
  const s = normalizeStatus(meta?.status)
  if (s === STATUS.FLOODWAIT) {
    const back = normalizeStatus(meta?.prevStatus)
    return isRunnable(back) ? back : STATUS.ACTIVE
  }
  if (s === STATUS.QUARANTINE) return STATUS.WARMING
  return null
}
