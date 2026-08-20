/**
 * Занятость аккаунта ДЕЙСТВИЕМ — сквозь все модули (решение владельца 20.08).
 *
 * Работа в нескольких модулях разрешена (лок «один аккаунт = одна задача» ослаблен до
 * «один аккаунт = один модуль КАЖДОГО типа», см. accountLocks.js), но человек физически
 * не может комментировать и писать в ЛС в одну и ту же секунду (ТЗ 19.08 §4, «будущая
 * модель» — включена досрочно). Этот реестр и есть та физика:
 *
 *  - пока аккаунт занят действием одной задачи, другая его не берёт — пропускает с
 *    логом и возвращается позже (та же механика, что усталость/распорядок);
 *  - при переключении МЕЖДУ модулями выдерживается случайная пауза — человек, который
 *    только что дописал коммент, не отправляет ЛС в ту же миллисекунду.
 *
 * Реестр живёт в памяти процесса, как и остальные локи: после рестарта задачи всё
 * равно переподнимаются заново.
 */
import { moduleLabel } from './accountLocks.js'

/** @type {Map<string, { moduleKey: string, taskId: string, since: number }>} */
const busy = new Map()

/** Последнее завершённое действие: для паузы при переключении модулей.
 * @type {Map<string, { moduleKey: string, at: number, coolMs: number }>} */
const last = new Map()

/** Пауза при переключении модулей: случайная, чтобы не было машинного ритма.
 * Ориентиры владельца — «коммент→ЛС ≈ 3 с, ЛС→реакция ≈ 0.5 с». */
const SWITCH_COOL_MS = [1000, 5000]

/** Сколько предложить подождать, когда аккаунт занят чужим действием, а срок
 * его окончания неизвестен (действие может тянуться из-за задержек модуля). */
export const BUSY_RETRY_MS = 15 * 1000

const rndCool = () => SWITCH_COOL_MS[0] + Math.floor(Math.random() * (SWITCH_COOL_MS[1] - SWITCH_COOL_MS[0] + 1))

/**
 * Попробовать занять аккаунт действием. Не блокирует: занято — вернёт причину и когда
 * пробовать снова, ровно в форме гейтов усталости/распорядка (воркеры уже умеют её
 * пропускать, логировать и ждать).
 * @param {string} accountId @param {string} moduleKey @param {string} taskId
 * @returns {{ok: true} | {ok: false, reason: string, until: number}}
 */
export function beginAccountWork(accountId, moduleKey, taskId, now = Date.now()) {
  const cur = busy.get(accountId)
  if (cur && cur.taskId !== taskId) {
    return {
      ok: false,
      reason: `занят действием в модуле «${moduleLabel(cur.moduleKey)}»`,
      until: now + BUSY_RETRY_MS,
    }
  }
  const prev = last.get(accountId)
  if (!cur && prev && prev.moduleKey !== moduleKey && now < prev.at + prev.coolMs) {
    return {
      ok: false,
      reason: `пауза при переключении модулей: ${moduleLabel(prev.moduleKey)} → ${moduleLabel(moduleKey)}`,
      until: prev.at + prev.coolMs,
    }
  }
  busy.set(accountId, { moduleKey, taskId, since: now })
  return { ok: true }
}

/**
 * Освободить аккаунт после действия. Идемпотентно: чужой слот не трогает.
 * @param {string} accountId @param {string} taskId
 */
export function endAccountWork(accountId, taskId, now = Date.now()) {
  const cur = busy.get(accountId)
  if (!cur || cur.taskId !== taskId) return
  busy.delete(accountId)
  last.set(accountId, { moduleKey: cur.moduleKey, at: now, coolMs: rndCool() })
}

/**
 * Дождаться свободного слота (для потоковых модулей — мейлинг, диалоги, — где пропуск
 * невозможен: собеседник ждёт ответа). Возвращает, сколько миллисекунд прождали.
 * По таймауту занимает слот принудительно — лучше редкое наложение, чем зависший диалог.
 * @param {string} accountId @param {string} moduleKey @param {string} taskId
 * @param {{timeoutMs?: number, sleep?: (ms:number)=>Promise<void>}} [opts]
 */
export async function waitAccountWork(accountId, moduleKey, taskId, opts = {}) {
  const timeout = opts.timeoutMs ?? 2 * 60 * 1000
  const doSleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const started = Date.now()
  for (;;) {
    const gate = beginAccountWork(accountId, moduleKey, taskId)
    if (gate.ok) return Date.now() - started
    if (Date.now() - started >= timeout) {
      busy.set(accountId, { moduleKey, taskId, since: Date.now() })
      return Date.now() - started
    }
    await doSleep(Math.min(500, Math.max(50, gate.until - Date.now())))
  }
}

/** Страховка: снять все слоты задачи при её завершении (пути с break минуют finally). */
export function releaseTaskBusy(taskId, now = Date.now()) {
  for (const [accountId, cur] of busy) {
    if (cur.taskId === taskId) {
      busy.delete(accountId)
      last.set(accountId, { moduleKey: cur.moduleKey, at: now, coolMs: rndCool() })
    }
  }
}

/** Для карточки аккаунта: чем занят прямо сейчас (null — свободен). */
export function getAccountBusy(accountId) {
  const cur = busy.get(accountId)
  return cur ? { ...cur, moduleLabel: moduleLabel(cur.moduleKey) } : null
}
