/**
 * SPEC §4.1–§4.3 (D1, D3): усталость и распорядок дня аккаунта — СКВОЗЬ МОДУЛИ.
 *
 * Заказчик: аккаунты «работают на похуй» — есть пауза между действиями, и всё.
 * Освободившийся аккаунт тут же уходил лить 50 реакций в другом модуле, потому что
 * счётчики жили в ЗАДАЧЕ: каждая задача начинала считать с нуля и не знала, что
 * профиль только что отработал смену в соседнем.
 *
 * Здесь — чистые функции без I/O: хранение и запись живут в `server/accountActivity.js`,
 * а вся арифметика тестируется изолированно.
 *
 * Модель намеренно простая и предсказуемая:
 *   усталость += 1 за действие, и падает со временем (восстановление за час отдыха).
 * Человек после 10–20 комментариев устаёт — отсюда порог по умолчанию.
 */

/** Профиль усталости по умолчанию. Задаётся на аккаунт и массово (§4.5). */
export const DEFAULT_FATIGUE = {
  /** Сколько действий подряд аккаунт выдерживает, прежде чем уйти на отдых. */
  threshold: 15,
  /** Сколько единиц усталости «сгорает» за час отдыха. */
  recoveryPerHour: 5,
  /** Минимальный отдых после переутомления, минут — даже если формально восстановился. */
  restMinutes: 45,
}

/**
 * Распорядок «работяги» из звонка (§4.2): вероятность привлечения по часам.
 * Ночью 2–5 не пишем вовсе — людей, пишущих в это время, мало, и это палит ботов.
 * Ключ — час (0–23), значение — вероятность 0..1.
 */
export const DEFAULT_SCHEDULE = {
  0: 0.02, 1: 0.01, 2: 0, 3: 0, 4: 0, 5: 0,
  6: 0.05, 7: 0.35, 8: 0.15,
  9: 0.03, 10: 0.03, 11: 0.03, 12: 0.03, 13: 0.03, 14: 0.03,
  15: 0.3, 16: 0.3,
  17: 0.02,
  18: 0.07, 19: 0.07, 20: 0.07,
  21: 0.05, 22: 0.04, 23: 0.03,
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Текущая усталость с учётом восстановления. Чистая функция.
 * @param {{fatigue?:number, lastActionAt?:number}} state
 * @param {{recoveryPerHour?:number}} profile
 * @param {number} [now]
 */
export function currentFatigue(state = {}, profile = DEFAULT_FATIGUE, now = Date.now()) {
  const base = Math.max(0, Number(state.fatigue) || 0)
  const last = Number(state.lastActionAt) || 0
  if (!base || !last) return base
  const hours = Math.max(0, (now - last) / HOUR_MS)
  const rec = Math.max(0, Number(profile.recoveryPerHour ?? DEFAULT_FATIGUE.recoveryPerHour))
  return Math.max(0, Math.round((base - hours * rec) * 100) / 100)
}

/**
 * Может ли аккаунт работать прямо сейчас: не устал ли и не на обязательном ли отдыхе.
 * @returns {{ok:true} | {ok:false, reason:string, until?:number}}
 */
export function fatigueGate(state = {}, profile = DEFAULT_FATIGUE, now = Date.now()) {
  const p = { ...DEFAULT_FATIGUE, ...(profile || {}) }
  // Обязательный отдых после переутомления: пока он не вышел, аккаунт не берём,
  // даже если арифметика восстановления уже опустила усталость ниже порога.
  const until = Number(state.restUntil) || 0
  if (until > now) {
    return { ok: false, reason: `отдыхает после нагрузки (ещё ${Math.ceil((until - now) / 60000)} мин)`, until }
  }
  const f = currentFatigue(state, p, now)
  if (f >= p.threshold) {
    return { ok: false, reason: `устал (${f} из ${p.threshold}) — нужен отдых`, until: now + p.restMinutes * 60000 }
  }
  return { ok: true }
}

/**
 * Новое состояние после совершённого действия. Возвращает патч, а не мутирует вход.
 * @param {object} state @param {object} profile @param {number} [now]
 */
export function applyAction(state = {}, profile = DEFAULT_FATIGUE, now = Date.now()) {
  const p = { ...DEFAULT_FATIGUE, ...(profile || {}) }
  const f = Math.round((currentFatigue(state, p, now) + 1) * 100) / 100
  const patch = {
    fatigue: f,
    lastActionAt: now,
    actionsTotal: (Number(state.actionsTotal) || 0) + 1,
  }
  // Достиг порога — уходит на обязательный отдых. Именно это и делает отдых
  // СКВОЗНЫМ: следующий модуль увидит restUntil и не возьмёт аккаунт.
  if (f >= p.threshold) patch.restUntil = now + p.restMinutes * 60000
  return patch
}

/**
 * §4.2: «бросок кубика» по распорядку. Модуль вызывает это перед тем, как взять
 * аккаунт: попал в вероятность — работаем, нет — идём к следующему.
 * @param {Record<number,number>} schedule @param {number} [now] @param {() => number} [rnd]
 */
export function scheduleGate(schedule = DEFAULT_SCHEDULE, now = Date.now(), rnd = Math.random) {
  const hour = new Date(now).getHours()
  const table = schedule && typeof schedule === 'object' ? schedule : DEFAULT_SCHEDULE
  const p = Number(table[hour] ?? DEFAULT_SCHEDULE[hour] ?? 0)
  if (p <= 0) return { ok: false, reason: `по распорядку в ${hour}:00 аккаунт не активен`, chance: 0 }
  if (rnd() > p) return { ok: false, reason: `не попал в вероятность ${Math.round(p * 100)}% для ${hour}:00`, chance: p }
  return { ok: true, chance: p }
}

/** Нормализовать профиль усталости из пользовательского ввода (форма/массовое задание). */
export function normalizeFatigueProfile(input = {}) {
  const n = (v, d, min, max) => {
    const x = Math.round(Number(v))
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d
  }
  return {
    threshold: n(input.threshold, DEFAULT_FATIGUE.threshold, 1, 500),
    recoveryPerHour: n(input.recoveryPerHour, DEFAULT_FATIGUE.recoveryPerHour, 1, 100),
    restMinutes: n(input.restMinutes, DEFAULT_FATIGUE.restMinutes, 1, 24 * 60),
  }
}
