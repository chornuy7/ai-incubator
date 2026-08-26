import { scheduleHour } from './accountFatigue.js'

/**
 * План прогрева по уровню (§8.2). 0 = Быстрый (2 дня, интенсивнее), 1 = Нормальный (3–7),
 * 2 = Стандартный (7–14, мягче/естественнее). Чистая функция.
 * `mul` — множитель задержек (длиннее уровень → медленнее темп); `actionsPerDay` — ориентир
 * дневной активности на аккаунт. @param {number} level
 * @returns {{ level:number, label:string, mul:number, actionsPerDay:number }}
 */
export function warmingPace(level) {
  // weights — пропорция действий прогрева (§8.2, решение 15.07):
  // просмотр постов 40% · реакции 20% · чтение/ЛС 20% · вступления 10% · подписки/ping 10%.
  const weights = { view: 40, react: 20, read: 20, join: 10, ping: 10 }
  const plans = [
    // Названия — про ТЕМП, а не про срок: «(2 дня)» читалось как длительность запуска
    // и расходилось с ETA задачи (вопрос владельца 26.08). Срок задаёт лимит действий.
    { level: 0, label: 'Быстрый (~40 действий/день)', mul: 0.8, actionsPerDay: 40, weights },
    { level: 1, label: 'Нормальный (~20 в день)', mul: 1.3, actionsPerDay: 20, weights },
    { level: 2, label: 'Бережный (~10 в день)', mul: 2.0, actionsPerDay: 10, weights },
  ]
  return plans[level] || plans[1]
}

/**
 * Взвешенный выбор ключа по весам. `r` ∈ [0,1) — для детерминизма в тестах.
 * @param {Record<string,number>} weights @param {number} r @returns {string}
 */
export function pickWeightedKey(weights, r = Math.random()) {
  const entries = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0)
  if (!entries.length) return ''
  const total = entries.reduce((s, [, w]) => s + Number(w), 0)
  let acc = Math.max(0, Math.min(1, r)) * total
  for (const [k, w] of entries) { acc -= Number(w); if (acc < 0) return k }
  return entries[entries.length - 1][0]
}

/** Попадает ли час в дневное окно активности прогрева (§8.2, ночью пауза). @param {number} hour @param {number} [startH] @param {number} [endH] */
export function inActiveWindow(hour, startH = 9, endH = 23) {
  return hour >= startH && hour < endH
}

/**
 * Длина дневного окна активности в мс — 9:00–23:00, четырнадцать часов.
 *
 * По ней считается темп прогрева: обещанные «10 действий в день» — это 10 действий за
 * ЭТО окно, а не за 13 минут подряд (правка 22.08 после замера на живых аккаунтах).
 */
export const WARM_WINDOW_MS = 14 * 60 * 60 * 1000

/**
 * Сколько миллисекунд до ближайшего наступления заданного часа ПО КИЕВСКОМУ времени.
 * Нужен ночной паузе прогрева: «возобновим в 9:00» должно значить девять утра у
 * клиента, а не на сервере.
 * @param {number} hour @param {number} [now]
 */
export function msUntilHour(hour, now = Date.now()) {
  const HOUR = 60 * 60 * 1000
  for (let i = 1; i <= 24; i += 1) {
    const ts = now + i * HOUR
    if (scheduleHour(ts) === hour) {
      // Попали в нужный час — доводим до его начала, чтобы не стартовать в 9:59.
      const d = new Date(ts)
      d.setMinutes(0, 0, 0)
      return Math.max(HOUR, d.getTime() - now)
    }
  }
  return 8 * HOUR // не смогли посчитать — спим до утра ориентировочно
}

/** @param {object} task @param {boolean} progressed @param {number} [maxIdle] */
export function trackIdlePass(task, progressed, maxIdle = 5) {
  if (progressed) {
    task.idlePasses = 0
    return false
  }
  task.idlePasses = (task.idlePasses || 0) + 1
  return task.idlePasses >= maxIdle
}

/**
 * Задача сдалась после серии холостых кругов — пометить это ЧЕСТНО.
 *
 * Прогон 26.08: нейрокомментинг пять кругов подряд ничего не отправил (спамблок,
 * вероятность, распорядок), написал «Остановка: комментарий не отправлен после
 * нескольких попыток» — и следующей строкой «Завершено», а в дашборде встал зелёным
 * «готово» на 9%. Провал выглядел успехом, потому что `statusAfterRun` смотрит только
 * на fatalError/stopRequested, а холостой выход не ставил ни того, ни другого.
 *
 * @param {object} task @param {string} reason почему сдались — попадёт в итоговую строку
 */
export function markIdleStop(task, reason) {
  task.stopRequested = true
  task.idleStopReason = String(reason || '')
}

/**
 * Максимум, сколько задача ждёт освобождения аккаунтов, прежде чем завершиться.
 *
 * Правка 19.08: потолок поднят с 30 минут до 12 часов. Отдых аккаунта — штатная часть
 * работы, а не сбой: задача с одним аккаунтом и отдыхом в час завершалась, не сделав и
 * половины. Пока известно ТОЧНОЕ время возврата (конец отдыха), ждать правильнее, чем
 * закрываться; задача при этом остаётся «в работе» и пишет в лог, когда аккаунт вернётся.
 * Потолок оставлен, чтобы ночной распорядок не держал задачу сутками.
 *
 * Правка 18.08. Раньше круг, где ВСЕ аккаунты временно недоступны, означал конец
 * задачи: живой прогон нейрокомментинга сделал 1 действие из 2 и завершился словами
 * «отдыхает после нагрузки (ещё 2 мин)». Ждать две минуты было бы честнее, чем
 * отдавать половину результата.
 *
 * Потолок нужен, чтобы задача не висела сутки из-за ночного распорядка: если ближайшее
 * окно дальше, честнее закончить и сказать, когда аккаунты освободятся.
 */
export const IDLE_WAIT_CAP_MS = 12 * 60 * 60 * 1000

/**
 * Ждать ли, пока освободится хоть один аккаунт.
 *
 * @param {number} until  время ближайшего освобождения (0 — неизвестно)
 * @param {number} [now]
 * @returns {{wait:false} | {wait:true, ms:number, minutes:number}}
 */
export function idleWaitPlan(until, now = Date.now()) {
  const ms = Number(until) - now
  // Причина «исчерпан лимит» времени освобождения не имеет — ждать нечего.
  if (!Number.isFinite(ms) || ms <= 0) return { wait: false }
  if (ms > IDLE_WAIT_CAP_MS) return { wait: false }
  return { wait: true, ms, minutes: Math.max(1, Math.ceil(ms / 60000)) }
}

/** Есть ли в тексте хотя бы одно из слов (регистронезависимо). @param {string} text @param {string[]} words */
export function postContainsAny(text, words) {
  if (!words?.length) return false
  const lower = (text || '').toLowerCase()
  return words.some((w) => { const t = String(w).trim().toLowerCase(); return t && lower.includes(t) })
}

/** @param {object[]} posts @param {object} settings */
export function pickCommentCandidates(posts, settings) {
  const textOf = (p) => (p.message || '').trim() || (p.media ? '[медиа]' : '')
  let candidates = posts.filter((p) => postMeetsMinWords(textOf(p), settings.minWords || 0))
  if (settings.commentMode === 1) {
    candidates = candidates.filter((p) => postMatchesKeywords(textOf(p), settings.keywords || []))
  }
  // §3.5 семантика/тональность (фильтр): пропускаем посты со стоп-словами (нежелательные темы/тон).
  if (settings.stopWords?.length) {
    candidates = candidates.filter((p) => !postContainsAny(textOf(p), settings.stopWords))
  }
  // ГЛУБИНА: сколько постов канала вообще рассматриваем.
  //   0 — только последний · 1 — все, кроме последнего (устаревшее, из UI убрано)
  //   2 — все, что отдал Telegram · 3 — последние N (lastPostsCount)
  const postFilter = settings.postFilter ?? 0
  if (postFilter === 0 && candidates.length) {
    const newest = Math.max(...candidates.map((p) => p.id))
    candidates = candidates.filter((p) => p.id === newest)
  } else if (postFilter === 1 && candidates.length) {
    const newest = Math.max(...posts.map((x) => x.id))
    candidates = candidates.filter((p) => p.id !== newest)
  } else if (postFilter === 3 && candidates.length) {
    // «Последние N»: N считаем по ленте канала, а не по прошедшим фильтр — иначе при
    // жёстких ключевых словах «последние 3» уехали бы вглубь истории.
    const depth = Math.min(50, Math.max(1, Math.trunc(Number(settings.lastPostsCount) || 0) || 3))
    const allowed = new Set([...posts].sort((a, b) => b.id - a.id).slice(0, depth).map((p) => p.id))
    candidates = candidates.filter((p) => allowed.has(p.id))
  }
  // Один случайный из подходящих. Раньше это было СЛИТО с отбором по содержанию
  // (`commentMode: 0` = «Случайный»), из-за чего «случайный» и «по ключевым словам»
  // выглядели взаимоисключающими, хотя это разные вопросы: ЧТО подходит и СКОЛЬКО брать.
  // Старые задачи (commentMode 0) продолжают работать по-прежнему.
  const pickOne = settings.pickOne ?? (settings.commentMode === 0)
  if (pickOne && candidates.length > 1) {
    candidates = [candidates[Math.floor(Math.random() * candidates.length)]]
  }
  return candidates
}

function postMeetsMinWords(text, minWords) {
  if (!minWords) return true
  return (text || '').trim().split(/\s+/).filter(Boolean).length >= minWords
}

function postMatchesKeywords(text, keywords) {
  if (!keywords?.length) return true
  const lower = (text || '').toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}
