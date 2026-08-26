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

const HOUR_MS = 3600000

/**
 * Профиль усталости по умолчанию (§4.5). ТРИ раздельных параметра — так в ТЗ 19.08 §4
 * («порог = действий, отдых отдельно, восстановление отдельно»), владелец подтвердил
 * 20.08. Чтобы поля не «спорили числами» (грабли 18.08), роли разведены жёстко:
 *   - отдых — обязательный перерыв ПОСЛЕ порога; отбыл — счётчик обнулён, точка;
 *   - восстановление — таяние счётчика в ОБЫЧНЫХ перерывах, когда до порога не дошли.
 * После отбытого отдыха восстановление ничего не «довосстанавливает» — нечего.
 */
export const DEFAULT_FATIGUE = {
  /** Порог действий: сколько подряд аккаунт выдерживает, прежде чем уйти на отдых. */
  threshold: 15,
  /** «Отдых после действия», минут (в форме — часы и минуты). После него счётчик обнулён. */
  restMinutes: 45,
  /**
   * Восстановление: за какое ВРЕМЯ ПРОСТОЯ уходит одна единица усталости (мс).
   *
   * Раньше это была скорость «единиц в час» — целое число, и потому вопрос владельца
   * 21.08 «почему только за час, почему нет минут» был по делу: «одна единица за 20
   * минут» такой шкалой не выражается совсем, а «одна за полтора часа» тем более.
   * Период же выражает и то, и другое, и читается ближе к тому, как о нём думают:
   * «сколько нужно постоять, чтобы отдохнуть на единицу».
   *
   * Умолчание 12 минут = прежние 5 единиц в час, поэтому у существующих аккаунтов
   * поведение не меняется.
   */
  recoveryEveryMs: 12 * 60 * 1000,
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


/**
 * Период восстановления из профиля, в мс. 0 — восстановление выключено.
 *
 * Понимает и старое поле `recoveryPerHour` (единиц в час): профили аккаунтов уже лежат
 * в базе с ним, и переписывать их миграцией ради смены единиц измерения — лишний риск
 * там, где хватает пересчёта на чтении.
 * @param {{recoveryEveryMs?:number, recoveryPerHour?:number}} profile
 */
export function recoveryEveryMs(profile = {}) {
  // Старое поле проверяем ПЕРВЫМ и только если оно задано явно: профиль обычно приходит
  // слитым с умолчаниями (`{...DEFAULT_FATIGUE, ...profile}`), и новое поле из умолчаний
  // иначе перебивало бы явно выставленное «восстановление выключено».
  if (profile.recoveryPerHour !== undefined && profile.recoveryPerHour !== null) {
    const perHour = Number(profile.recoveryPerHour)
    if (!Number.isFinite(perHour) || perHour <= 0) return 0
    return Math.round(HOUR_MS / perHour)
  }
  const explicit = Number(profile.recoveryEveryMs)
  if (Number.isFinite(explicit) && explicit >= 0) return Math.max(0, Math.round(explicit))
  return DEFAULT_FATIGUE.recoveryEveryMs
}

/**
 * Текущая усталость с учётом восстановления. Чистая функция.
 * @param {{fatigue?:number, lastActionAt?:number, restUntil?:number}} state
 * @param {{threshold?:number, restMinutes?:number, recoveryPerHour?:number}} profile
 * @param {number} [now]
 */
export function currentFatigue(state = {}, profile = DEFAULT_FATIGUE, now = Date.now()) {
  const p = { ...DEFAULT_FATIGUE, ...(profile || {}) }
  // Счётчик не может уйти выше порога: «2 из 1» — бессмыслица, аккаунт при пороге 1
  // отдыхает уже после первого действия (правка 19.08).
  const base = Math.min(Math.max(0, Number(state.fatigue) || 0), Math.max(1, p.threshold))
  const last = Number(state.lastActionAt) || 0
  if (!base || !last) return base
  // Обязательный отдых ОТБЫТ — усталость обнулена: отдых для того и назначается,
  // чтобы после него вернуться в строй (правка 18.08, подтверждено 20.08).
  const rested = Number(state.restUntil) || 0
  if (rested && now >= rested && last <= rested) return 0
  // Восстановление (ТЗ 19.08 §4, отдельный параметр): в обычных перерывах, когда до
  // порога не дошли, счётчик тает recoveryPerHour единиц за час простоя. Счётчик —
  // ЦЕЛОЕ число действий: округляем ВВЕРХ, чтобы не было «0.8 из 1» и начатое
  // действие считалось сделанным, пока час восстановления не пройден целиком.
  const every = recoveryEveryMs(p)
  if (!every) return base                       // восстановление выключено
  const recovered = Math.max(0, (now - last) / every)
  return Math.max(0, Math.ceil(base - recovered))
}

/**
 * Когда аккаунт снова сможет работать. 0 — может прямо сейчас.
 *
 * Две причины простоя дают разное время. Назначен обязательный перерыв — ждём его конца.
 * Перерыва нет, но счётчик выше порога (так бывает, когда порог ПОНИЗИЛИ уже после
 * работы: было «2 из 15», стало «2 из 1») — ждём, пока восстановление опустит его под
 * порог. Без этого числа карточка говорила «устал», но не говорила, до каких пор.
 */
export function freeAt(state = {}, profile = DEFAULT_FATIGUE, now = Date.now()) {
  const p = { ...DEFAULT_FATIGUE, ...(profile || {}) }
  const rest = Number(state.restUntil) || 0
  if (rest > now) return rest
  const f = currentFatigue(state, p, now)
  if (f < p.threshold) return 0
  // Перерыв не назначен, но счётчик на пороге (порог ПОНИЗИЛИ после работы):
  // ждём, пока восстановление опустит его под порог. Счётчик целый (округление
  // вверх), поэтому «ниже порога» наступает, когда сырое значение дойдёт до
  // threshold - 1. Восстановление выключено (0) — остаётся только один отдых.
  const every = recoveryEveryMs(p)
  if (!every) return now + p.restMinutes * 60000
  const last = Number(state.lastActionAt) || now
  const base = Math.min(Math.max(0, Number(state.fatigue) || 0), Math.max(1, p.threshold))
  // Счётчик целый (округление вверх), поэтому «ниже порога» наступает, когда стает
  // ровно одна единица сверх threshold - 1.
  const needed = base - (p.threshold - 1)
  return Math.max(now, last + needed * every)
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
  // Потолок — порог: выше него счётчик бессмыслен, аккаунт уже на отдыхе (правка 19.08).
  const f = Math.min(Math.max(1, p.threshold), currentFatigue(state, p, now) + 1)
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
/** Базовый шаг повтора броска по распорядку. Реальный срок считает `rollRetryMs`. */
export const ROLL_RETRY_MS = 60 * 1000

/**
 * Через сколько повторять бросок, если не повезло, — С УЧЁТОМ ШАНСА ЧАСА.
 *
 * Фиксированная минута была одинаковой и для 89%, и для 5%: в первом случае аккаунт
 * простаивал минуту там, где следующий бросок почти наверняка удачен, во втором —
 * молотил вхолостую 12 раз в час. Требование владельца 21.08: «не опрашивать столько-то
 * раз, а выставить такую задержку, чтобы при повторном дёргании он уже был активным».
 *
 * Считаем среднее ожидание до удачного броска: при шансе p на одну удачу приходится
 * (1 - p) / p неудач. При 89% это ≈ 7 секунд, при 10% — ≈ 9 минут. Верхняя граница —
 * конец текущего часа: дальше меняется сам шанс, и ждать по старому числу бессмысленно.
 *
 * @param {number} chance шанс часа, 0..1 @param {number} [now]
 * @returns {number} мс до следующей попытки
 */
export function rollRetryMs(chance, now = Date.now()) {
  const p = Math.min(1, Math.max(0.01, Number(chance) || 0.01))
  const expected = Math.round(ROLL_RETRY_MS * (1 - p) / p)
  const hourEnd = new Date(now)
  hourEnd.setMinutes(0, 0, 0)
  hourEnd.setHours(hourEnd.getHours() + 1)
  const tillHourEnd = Math.max(5000, hourEnd.getTime() - now)
  // Не меньше пяти секунд: иначе при шансе 99% воркер крутился бы вхолостую.
  return Math.min(tillHourEnd, Math.max(5000, expected))
}

/**
 * Час распорядка — КИЕВСКИЙ, а не локальный час сервера.
 *
 * Распорядок задаёт человек: «в 11:00 аккаунт активен на 87%» — это его время, время
 * оператора. Сервер же брал `new Date().getHours()`, то есть свой часовой пояс; на проде
 * это UTC, на три часа позади. В 11:00 по Киеву бралась вероятность из ячейки 8:00 —
 * прогон 19.08 это и показал: в расписании стояло 87%, а в логе «не выпало 76%».
 *
 * Пояс тот же, что и во всём интерфейсе (правка 06.08: хранение UTC, показ Europe/Kyiv).
 */
export const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Europe/Kyiv'

/**
 * Время для ЛОГА — в зоне распорядка, а не в зоне сервера (правка 27.08).
 *
 * Прод стоит в UTC, владелец в Киеве (+3), а дашборд рисует отметки логов браузером,
 * то есть по-киевски. Из-за этого сервер писал внутрь строки своё время: в 00:18 в логе
 * появлялось «все аккаунты отдыхают, вернутся в 21:19» — обещание вернуться в прошлое.
 * Тот же перекос был у спамблока: «выведен до 21:11» вместо «до 00:11 следующего дня».
 *
 * Зона берётся та же, по которой считается распорядок: если аккаунт «работает до 22:00»
 * по Киеву, то и «вернётся в 21:19» должно означать киевские 21:19.
 */
export function logTime(ms, withDate = false) {
  const d = new Date(ms)
  const opts = { timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit' }
  if (!withDate) return d.toLocaleTimeString('ru-RU', opts)
  return d.toLocaleString('ru-RU', { ...opts, day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function scheduleHour(ms = Date.now(), tz = SCHEDULE_TZ) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms))
    return Number(h) % 24 // полночь в некоторых локалях приходит как «24»
  } catch {
    return new Date(ms).getHours() // неизвестный пояс — не падаем, работаем как раньше
  }
}

export function scheduleGate(schedule = DEFAULT_SCHEDULE, now = Date.now(), rnd = Math.random) {
  const hour = scheduleHour(now)
  const table = schedule && typeof schedule === 'object' ? schedule : DEFAULT_SCHEDULE
  const p = Number(table[hour] ?? DEFAULT_SCHEDULE[hour] ?? 0)
  // `until` — когда есть смысл пробовать снова. Для распорядка это следующий час:
  // раньше воркер получал только «нельзя» и завершал задачу, хотя ждать было минуту.
  const nextHour = new Date(now)
  nextHour.setMinutes(0, 0, 0)
  nextHour.setHours(nextHour.getHours() + 1)
  // Час закрыт полностью — раньше следующего часа смысла пробовать нет.
  if (p <= 0) return { ok: false, reason: `распорядок дня: в ${hour}:00 аккаунт не работает`, chance: 0, until: nextHour.getTime() }
  // А вот НЕ ПОПАЛ В ВЕРОЯТНОСТЬ — это бросок кубика, и следующий бросок может выпасть
  // удачно через минуту. Ждать до конца часа тут неверно: при шансе 67% задача честно
  // сообщала «ждём 28 мин», хотя достаточно попробовать снова (правка 19.08).
  // Формулировка важна: это шанс РАСПОРЯДКА ДНЯ (когда аккаунт активен), а не «вероятность
  // действия» из настроек модуля. Прежний текст «не попал в вероятность 76%» читался как
  // «система подменила мои 100%» — прогон 19.08.
  /*
   * Бросок показываем ЧИСЛАМИ (MR-175, вопрос владельца 21.08: «89% — это меньше или в
   * другую сторону, непонятно, как считает»). Правило простое: выпавшее число должно
   * оказаться НЕ БОЛЬШЕ шанса часа. При 89% мимо пролетают только броски выше 89 —
   * то есть примерно один из девяти. Сама логика не инвертирована (это проверяет тест
   * «шанс распорядка не инвертирован»), но по логу убедиться в этом было нельзя.
   */
  const roll = rnd()
  const shown = { chance: Math.round(p * 100), roll: Math.round(roll * 100) }
  if (roll > p) {
    const retry = rollRetryMs(p, now)
    return {
      ok: false,
      reason: `распорядок дня: в ${hour}:00 аккаунт активен на ${shown.chance}%, выпало ${shown.roll} — мимо (проходит ${shown.chance} и меньше); следующая попытка через ${Math.max(1, Math.round(retry / 1000))} с`,
      chance: p,
      roll,
      until: now + retry,
    }
  }
  return { ok: true, chance: p, roll, reason: `распорядок дня: шанс ${shown.chance}%, выпало ${shown.roll} — работаем` }
}

/** Нормализовать профиль усталости из пользовательского ввода (форма/массовое задание). */
export function normalizeFatigueProfile(input = {}) {
  const n = (v, d, min, max) => {
    const x = Math.round(Number(v))
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d
  }
  return {
    threshold: n(input.threshold, DEFAULT_FATIGUE.threshold, 1, 500),
    restMinutes: n(input.restMinutes, DEFAULT_FATIGUE.restMinutes, 1, 24 * 60),
    // Период восстановления: от «сразу» (0 — выключено) до суток на единицу. Форма шлёт
    // часы и минуты, старые записи — единицы в час; recoveryEveryMs сводит оба вида.
    recoveryEveryMs: Math.min(24 * 60 * 60 * 1000, Math.max(0, recoveryEveryMs(input))),
  }
}
