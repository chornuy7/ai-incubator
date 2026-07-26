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
 * Распорядок дня (§4.2): вероятность привлечения по часам. Ключ — час (0–23),
 * значение — доля 0..1 (в интерфейсе это проценты 0–100%).
 *
 * Первая версия была списана со звонка буквально — «работяга на смене» с 3% днём.
 * На живом прогоне 23.07 это вылезло боком: комментинг честно отработал «Пропуск:
 * не попал в вероятность 2% для 17:00» и завершился с нулём действий. Формально
 * верно, практически — продукт выглядит сломанным. Поэтому шкала теперь рабочая:
 * днём аккаунт почти всегда доступен, а «человечность» держится не редкими бросками
 * кубика, а усталостью, паузами между действиями и РАЗНЫМИ распорядками у аккаунтов
 * (`scheduleForAccount`). Ночью 2–5 по-прежнему тишина: писать в это время — палиться.
 */
export const DEFAULT_SCHEDULE = {
  0: 0.10, 1: 0.05, 2: 0, 3: 0, 4: 0, 5: 0.02,
  6: 0.15, 7: 0.45, 8: 0.65,
  9: 0.8, 10: 0.85, 11: 0.85, 12: 0.75, 13: 0.9, 14: 0.85,
  15: 0.85, 16: 0.8,
  17: 0.75,
  18: 0.7, 19: 0.75, 20: 0.8,
  21: 0.75, 22: 0.55, 23: 0.3,
}

/**
 * Привести распорядок к внутреннему виду: 24 часа, доли 0..1.
 *
 * Интерфейс редактирует ПРОЦЕНТЫ (0–100) — так оператору понятнее, чем «0.85».
 * Отличить одно от другого можно надёжно: доля не бывает больше 1, а процент
 * меньше единицы («0.5%») практического смысла не имеет. Поэтому значения >1
 * читаем как проценты, ≤1 — как доли. Пропущенный час берём из умолчаний, а не
 * считаем нулём: иначе частично заполненная форма молча усыпила бы аккаунт.
 * @param {Record<number|string, number>|null} input
 * @param {Record<number, number>} [base] чем добивать пропуски
 */
export function normalizeSchedule(input, base = DEFAULT_SCHEDULE) {
  const src = input && typeof input === 'object' ? input : {}
  const asPercent = Object.values(src).some((v) => Number(v) > 1)
  const out = {}
  for (let h = 0; h < 24; h++) {
    const raw = src[h] ?? src[String(h)]
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) {
      out[h] = Number(base[h] ?? DEFAULT_SCHEDULE[h] ?? 0)
      continue
    }
    const v = Number(raw) / (asPercent ? 100 : 1)
    out[h] = Math.min(1, Math.max(0, Math.round(v * 1000) / 1000))
  }
  return out
}

/** Распорядок в процентах — для формы и отчётов. */
export function scheduleToPercent(schedule = DEFAULT_SCHEDULE) {
  const s = normalizeSchedule(schedule)
  const out = {}
  for (let h = 0; h < 24; h++) out[h] = Math.round(s[h] * 100)
  return out
}

/** Устойчивый хеш строки — чтобы «личный» распорядок аккаунта не менялся между запусками. */
function seedHash(s) {
  let h = 2166136261
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * §4.4: ЛИЧНЫЙ распорядок аккаунта.
 *
 * Один распорядок на всю ферму — сам по себе кластерный признак: 48 профилей
 * оживают и замолкают в одну и ту же минуту, и это видно со стороны лучше, чем
 * любая отдельная активность. Поэтому базовую кривую сдвигаем по времени
 * (±2 часа — «жаворонки и совы») и слегка меняем амплитуду.
 *
 * Сдвиг детерминированный, от id: аккаунт всегда живёт по одному и тому же
 * распорядку, а не превращается в человека с новым режимом сна каждый рестарт.
 * Ночную тишину не размываем — там ноль остаётся нулём.
 *
 * @param {string} accountId @param {Record<number,number>} [base]
 */
export function scheduleForAccount(accountId, base = DEFAULT_SCHEDULE) {
  const table = normalizeSchedule(base)
  if (!accountId) return table
  const h = seedHash(accountId)
  const shift = (h % 5) - 2                    // −2…+2 часа
  const amp = 0.8 + ((h >> 3) % 41) / 100      // 0.80…1.20 амплитуды
  const out = {}
  for (let hour = 0; hour < 24; hour++) {
    const from = (hour - shift + 24) % 24
    const v = table[from] * amp
    out[hour] = v <= 0 ? 0 : Math.min(1, Math.round(v * 1000) / 1000)
  }
  return out
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
