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
import { moduleLabel, isTaskLive, taskStartedAt } from './accountLocks.js'
import { switchPause, fmtDelay } from './humanDelays.js'

/** @type {Map<string, { moduleKey: string, taskId: string, since: number }>} */
const busy = new Map()

/** Последнее завершённое действие: для паузы при переключении модулей.
 * @type {Map<string, { moduleKey: string, at: number, coolMs: number }>} */
const last = new Map()

/*
 * Пауза при переключении модулей берётся из lib/humanDelays.js — там она с источником
 * и разбросом. Прежние 1–5 секунд были поставлены на глаз и человеку не соответствуют:
 * закончить комментировать и переключиться на переписку за секунду нельзя, в замерах
 * это порядка 25 секунд. Диапазон и происхождение — в humanDelays.
 */

/** Сколько предложить подождать, когда аккаунт занят чужим действием, а срок
 * его окончания неизвестен (действие может тянуться из-за задержек модуля). */
export const BUSY_RETRY_MS = 15 * 1000

/**
 * Через сколько слот МЁРТВОЙ задачи считается протухшим (самолечение, аналог
 * reconcileLocks). Живую задачу (isTaskLive) не трогаем вообще, сколько бы она слот ни
 * держала: нейродиалоги держат аккаунт весь проход по диалогам, парсер — всю цель, и
 * отнимать у них аккаунт по часам — это ровно та беда, что была у принудительного
 * захвата. Срок нужен только на гонку «слот взят / задача ещё не помечена живой».
 */
export const BUSY_STALE_MS = 5 * 60 * 1000

const rndCool = () => switchPause()

/**
 * Какая пауза переключения назначена аккаунту сейчас: модуль, из которого он вышел,
 * сколько ждать и до какого времени. Нужна карточке аккаунта — владелец 21.08:
 * «я должен видеть у аккаунта в информации, какая задержка между модулями применена».
 * `null` — аккаунт ничего не переключал или пауза уже вышла.
 * @param {string} accountId
 */
export function getSwitchPause(accountId, now = Date.now()) {
  const prev = last.get(accountId)
  if (!prev || now >= prev.at + prev.coolMs) return null
  return {
    fromModule: prev.moduleKey,
    fromLabel: moduleLabel(prev.moduleKey),
    coolMs: prev.coolMs,
    until: prev.at + prev.coolMs,
    leftMs: prev.at + prev.coolMs - now,
  }
}

/**
 * Отказ в слоте: отдельный тип ошибки, чтобы вызывающий отличал «аккаунт занят» от
 * сетевого сбоя. `code` — для кода, `message` — для лога оператора.
 */
export class AccountBusyError extends Error {
  /** @param {'ACCOUNT_BUSY'|'ABORTED_BY_STOP'} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'AccountBusyError'
    this.code = code
  }
}

/**
 * Снять слот, чей владелец заведомо мёртв: задачи нет в реестре живых воркеров и слот
 * висит дольше BUSY_STALE_MS. Без этого любой пропущенный endAccountWork (падение
 * промиса, выход мимо disconnectAccount) выключал аккаунт из ВСЕХ модулей до рестарта
 * процесса — лечилось только перезапуском, оператор этого даже не видел.
 * @returns {boolean} сняли ли слот
 */
function dropIfStale(accountId, cur, now) {
  if (!cur || isTaskLive(cur.taskId) || now - cur.since < BUSY_STALE_MS) return false
  busy.delete(accountId)
  // `last` не пишем: когда мёртвая задача реально закончила действие — неизвестно,
  // а лишняя пауза переключения тормозила бы уже ни в чём не виноватый модуль.
  return true
}

/**
 * Попробовать занять аккаунт действием. Не блокирует: занято — вернёт причину и когда
 * пробовать снова, ровно в форме гейтов усталости/распорядка (воркеры уже умеют её
 * пропускать, логировать и ждать).
 * @param {string} accountId @param {string} moduleKey @param {string} taskId
 * @returns {{ok: true} | {ok: false, reason: string, until: number}}
 */
/**
 * Очередь ожидания на аккаунт: accountId → Map(taskId → { since, moduleKey }).
 *
 * Зачем (просьба владельца 27.08: «первый запущенный имеет приоритет, второй ждёт или
 * пропускает, если есть другие аккаунты»).
 *
 * Слот отдавался тому, кто первым СПРОСИЛ после освобождения. Два модуля на одном
 * аккаунте опрашивают его каждые 15 секунд вразнобой, поэтому побеждал случайный: в
 * прогоне 27.08 нейрокомментинг и массовые реакции полчаса перетягивали один профиль,
 * а сделали одно действие на двоих.
 *
 * Теперь очередь помнит, КОГДА задача впервые попросила аккаунт, и пока в ней есть
 * задача постарше, младшая ждёт. Это не вытеснение: начатое действие всегда доводится
 * до конца — приоритет решает только, кто возьмёт аккаунт СЛЕДУЮЩИМ.
 */
const waiting = new Map()

/**
 * Сколько задача считается претендентом на аккаунт, не спрашивая его. Без этого срока
 * задача, взявшая аккаунт один раз и ушедшая заниматься другими, держала бы очередь
 * вечно; со сроком она просто выпадает из спора, как только перестала им пользоваться.
 */
const CLAIM_TTL_MS = 5 * 60_000

/**
 * Отметиться претендентом на аккаунт и узнать, есть ли задача СТАРШЕ.
 *
 * Старшинство — по моменту ЗАПУСКА задачи (`taskStartedAt`), а не по времени первого
 * запроса: иначе та, что спокойно работала и в очередь не вставала, при первом же споре
 * оказывалась «младшей».
 *
 * Претендентами считаются ВСЕ, кто просит аккаунт, включая нынешнего держателя. Ровно на
 * этом первая версия и ошиблась: держатель, получив слот, выходил из очереди, переставал
 * быть претендентом — и следующий круг младшая задача забирала аккаунт как «единственная
 * в очереди».
 */
function queuePosition(accountId, taskId, moduleKey, now) {
  let q = waiting.get(accountId)
  if (!q) { q = new Map(); waiting.set(accountId, q) }
  for (const [id, info] of q) {
    // Выбывают мёртвые и те, кто давно не спрашивал: спор идёт только между живыми.
    if (id !== taskId && (!isTaskLive(id) || now - info.lastAsk > CLAIM_TTL_MS)) q.delete(id)
  }
  const prev = q.get(taskId)
  q.set(taskId, {
    since: prev?.since ?? (taskStartedAt(taskId) || now),
    moduleKey,
    lastAsk: now,
  })
  const mine = q.get(taskId)
  let older = null
  for (const [id, info] of q) {
    if (id === taskId) continue
    if (info.since < mine.since && (!older || info.since < older.since)) older = { id, ...info }
  }
  return older
}

/** Выйти из спора — при завершении задачи (см. releaseTaskBusy). */
function queueLeave(accountId, taskId) {
  const q = waiting.get(accountId)
  if (!q) return
  q.delete(taskId)
  if (!q.size) waiting.delete(accountId)
}

export function beginAccountWork(accountId, moduleKey, taskId, now = Date.now()) {
  let cur = busy.get(accountId)
  // Прежде чем отказать — проверяем, жив ли вообще держатель (см. dropIfStale).
  if (cur && cur.taskId !== taskId && dropIfStale(accountId, cur, now)) cur = undefined
  if (cur && cur.taskId !== taskId) {
    // Занято — встаём в очередь, чтобы после освобождения слот достался по старшинству.
    queuePosition(accountId, taskId, moduleKey, now)
    return {
      ok: false,
      reason: `занят действием в модуле «${moduleLabel(cur.moduleKey)}»`,
      until: now + BUSY_RETRY_MS,
    }
  }

  /*
   * Свободен, но очередь может быть не наша. Задача, попросившая аккаунт раньше, забирает
   * его первой: без этого выигрывал тот, чей 15-секундный опрос случайно попал в момент
   * освобождения, и два модуля бесконечно перехватывали профиль друг у друга.
   */
  const older = queuePosition(accountId, taskId, moduleKey, now)
  if (!cur && older) {
    return {
      ok: false,
      reason: `аккаунт за модулем «${moduleLabel(older.moduleKey)}»: его задача запущена раньше и работает первой`,
      until: now + BUSY_RETRY_MS,
    }
  }
  const prev = last.get(accountId)
  if (!cur && prev && prev.moduleKey !== moduleKey && now < prev.at + prev.coolMs) {
    const left = prev.at + prev.coolMs - now
    return {
      ok: false,
      // В причине — И сколько назначено, И сколько осталось: без первого числа пауза
      // выглядит взявшейся ниоткуда, без второго непонятно, когда пробовать снова.
      reason: `пауза при переключении модулей ${moduleLabel(prev.moduleKey)} → ${moduleLabel(moduleKey)}: назначено ${fmtDelay(prev.coolMs)}, осталось ${fmtDelay(left)}`,
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
 * Дождаться свободного слота (для потоковых модулей — мейлинг, диалоги, — где карусельного
 * «пропустить и взять следующий аккаунт» нет). Успех — сколько миллисекунд прождали.
 *
 * Раньше по таймауту слот ОТБИРАЛСЯ у прежнего владельца. Отбирался молча и вхолостую:
 * тот продолжал работать со своим живым клиентом (его endAccountWork потом становился
 * no-op для чужого владельца), и мейлинг слал ЛС ровно в тот момент, когда нейродиалоги
 * отвечали тем же аккаунтом, — то есть физика «одно действие за раз» отваливалась именно
 * там, где обещала. А держат слот подолгу штатно: диалоги — весь проход, парсер — всю цель.
 *
 * Теперь — честный отказ: бросаем AccountBusyError, вызывающий переходит к следующей
 * цели/аккаунту. Бросок, а не код возврата, потому что единственный боевой вызывающий
 * (connectAccount) результат не смотрит: вернув «не смог», мы пустили бы его подключаться
 * БЕЗ слота — то самое наложение, которое чиним. Успешный путь по-прежнему отдаёт число.
 *
 * @param {string} accountId @param {string} moduleKey @param {string} taskId
 * @param {{timeoutMs?: number, sleep?: (ms:number)=>Promise<void>, shouldStop?: () => boolean}} [opts]
 * @returns {Promise<number>} миллисекунды ожидания
 * @throws {AccountBusyError} слот так и не освободился / задачу остановили
 */
export async function waitAccountWork(accountId, moduleKey, taskId, opts = {}) {
  const timeout = opts.timeoutMs ?? 2 * 60 * 1000
  const doSleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const started = Date.now()
  for (;;) {
    const gate = beginAccountWork(accountId, moduleKey, taskId)
    if (gate.ok) return Date.now() - started
    // «Стоп» не должен подвисать на каждом аккаунте до конца таймаута: без этой проверки
    // остановка задачи на 20 аккаунтах растягивалась на десятки минут ожидания впустую.
    if (opts.shouldStop?.()) {
      throw new AccountBusyError('ABORTED_BY_STOP', 'ABORTED_BY_STOP: ожидание свободного аккаунта прервано остановкой задачи')
    }
    if (Date.now() - started >= timeout) {
      throw new AccountBusyError('ACCOUNT_BUSY', `Аккаунт ${gate.reason} — ход пропущен`)
    }
    await doSleep(Math.min(500, Math.max(50, gate.until - Date.now())))
  }
}

/** Страховка: снять все слоты задачи при её завершении (пути с break минуют finally). */
export function releaseTaskBusy(taskId, now = Date.now()) {
  // Иначе завершённая задача продолжала бы «стоять в очереди» и блокировать младшую.
  for (const [accountId, q] of waiting) {
    q.delete(taskId)
    if (!q.size) waiting.delete(accountId)
  }
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

/** Все занятые аккаунты — для экрана занятости: залипший слот должно быть ВИДНО. */
export function getAllAccountBusy() {
  /** @type {Record<string, { moduleKey: string, taskId: string, since: number, moduleLabel: string }>} */
  const out = {}
  for (const id of busy.keys()) out[id] = /** @type {any} */ (getAccountBusy(id))
  return out
}

/**
 * Самолечение реестра занятости — как reconcileLocks у блокировок. Зовётся с экрана
 * занятости: слоты мёртвых задач снимаются, не дожидаясь следующей попытки взять аккаунт.
 * @returns {{ accountId: string, taskId: string, moduleKey: string }[]} снятые слоты
 */
export function reconcileBusy(now = Date.now()) {
  /** @type {{ accountId: string, taskId: string, moduleKey: string }[]} */
  const dropped = []
  for (const [accountId, cur] of [...busy]) {
    if (dropIfStale(accountId, cur, now)) dropped.push({ accountId, taskId: cur.taskId, moduleKey: cur.moduleKey })
  }
  return dropped
}
