/**
 * D1/D3 (SPEC §4.1–§4.3): усталость и распорядок аккаунта — сквозь модули.
 * Заказчик: аккаунты должны вести себя «как живые люди», а не работать без остановки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_FATIGUE, DEFAULT_SCHEDULE, currentFatigue, fatigueGate, freeAt,
  applyAction, scheduleGate, normalizeFatigueProfile, ROLL_RETRY_MS,
  normalizeSchedule, scheduleToPercent, scheduleForAccount, scheduleHour, rollRetryMs,
} from '../lib/accountFatigue.js'

const HOUR = 60 * 60 * 1000

/**
 * Момент, у которого КИЕВСКИЙ час равен `h` (минуты — `m`).
 *
 * Распорядок читается по киевскому часу (правка 21.08), а `new Date().setHours(h)` давал
 * час МАШИНЫ. На ноутбуке в Киеве это одно и то же, поэтому локально всё было зелено, —
 * а сборщик GitHub живёт в UTC, и там те же тесты падали на расхождении в три часа. Тест
 * не должен зависеть от того, где его запустили, поэтому час подбираем тем же способом,
 * которым его читает код.
 */
const at = (h, m = 0) => {
  const day = Date.UTC(2026, 7, 19) // будний день вдали от перевода часов
  for (let k = 0; k < 24; k += 1) {
    const ts = day + k * HOUR + m * 60000
    if (scheduleHour(ts, 'Europe/Kyiv') === h) return ts
  }
  throw new Error(`не нашли момент с киевским часом ${h}`)
}

test('§4.1: после порога действий аккаунт уходит на отдых', () => {
  const now = Date.now()
  let st = {}
  for (let i = 0; i < DEFAULT_FATIGUE.threshold; i++) st = { ...st, ...applyAction(st, DEFAULT_FATIGUE, now) }
  assert.equal(st.fatigue, DEFAULT_FATIGUE.threshold)
  assert.ok(st.restUntil > now, 'достиг порога — назначен обязательный отдых')
  assert.equal(fatigueGate(st, DEFAULT_FATIGUE, now).ok, false)
})

test('§4.1: отдых СКВОЗНОЙ — обязательная пауза не обходится восстановлением', () => {
  const now = Date.now()
  // Усталость уже сгорела по времени, но принудительный отдых ещё идёт: именно это
  // не даёт освободившемуся аккаунту тут же уйти лить реакции в другом модуле.
  const st = { fatigue: 0, lastActionAt: now - 10 * HOUR, restUntil: now + 10 * 60000 }
  const g = fatigueGate(st, DEFAULT_FATIGUE, now)
  assert.equal(g.ok, false)
  assert.match(g.reason, /отдыхает/)
})

/**
 * ТЗ 19.08 §4 (подтверждено владельцем 20.08): три раздельных параметра.
 * Восстановление тает в обычных перерывах; отбытый отдых обнуляет счётчик целиком.
 */
test('§4.1: усталость восстанавливается со временем', () => {
  const now = Date.now()
  const st = { fatigue: 10, lastActionAt: now - 2 * HOUR }
  assert.equal(currentFatigue(st, DEFAULT_FATIGUE, now), 0, '2 часа × 5 ед./час = 10')
  assert.equal(currentFatigue({ fatigue: 10, lastActionAt: now - HOUR }, DEFAULT_FATIGUE, now), 5)
  // Отбытый отдых обнуляет сразу, не дожидаясь арифметики восстановления.
  const rested = { fatigue: 10, lastActionAt: now - 2 * HOUR, restUntil: now - HOUR }
  assert.equal(currentFatigue(rested, DEFAULT_FATIGUE, now), 0)
  // Восстановление выключено (0) — счётчик держится, снимает только отдых.
  const noRec = { threshold: 15, restMinutes: 45, recoveryPerHour: 0 }
  assert.equal(currentFatigue({ fatigue: 10, lastActionAt: now - 5 * HOUR }, noRec, now), 10)
})

test('§4.2: ночью 2–4 не пишем — это палит ботов', () => {
  for (const h of [2, 3, 4]) {
    const g = scheduleGate(DEFAULT_SCHEDULE, at(h), () => 0)
    assert.equal(g.ok, false, `в ${h}:00 аккаунт не должен работать даже при удачном броске`)
  }
})

test('§4.2: днём аккаунт РАБОТАЕТ, а не отсеивается броском кубика', () => {
  // Регресс живого прогона 23.07: при 2–3% днём модуль честно завершался с нулём
  // действий, и продукт выглядел сломанным. Человечность держат усталость и паузы,
  // а не редкие попадания в вероятность.
  for (const h of [9, 11, 13, 15, 17, 20]) {
    const g = scheduleGate(DEFAULT_SCHEDULE, at(h), () => 0.5)
    assert.equal(g.ok, true, `в ${h}:00 средний бросок обязан проходить, иначе модуль стоит`)
    assert.ok(g.chance >= 0.7, `${h}:00 — рабочий час, шанс ${g.chance} слишком мал`)
  }
})

test('§4.2: глубокая ночь всё же остаётся редкой', () => {
  assert.equal(scheduleGate(DEFAULT_SCHEDULE, at(1), () => 0.5).ok, false, 'в 1:00 пишут единицы')
})

test('§4.5: профиль нормализуется — мусор и крайности не проходят', () => {
  const p = normalizeFatigueProfile({ threshold: 0, recoveryPerHour: 'абв', restMinutes: 99999 })
  assert.equal(p.threshold, 1, 'ноль действий сделал бы аккаунт вечно уставшим')
  assert.equal(p.recoveryPerHour, DEFAULT_FATIGUE.recoveryPerHour)
  assert.equal(p.restMinutes, 24 * 60, 'отдых дольше суток — почти наверняка опечатка')
})

test('applyAction не мутирует исходное состояние', () => {
  const st = { fatigue: 1, actionsTotal: 1 }
  const copy = { ...st }
  applyAction(st, DEFAULT_FATIGUE, Date.now())
  assert.deepEqual(st, copy)
})

// ── D4 (§4.4): анти-кластер — Telegram банит волнами по паттерну ──
test('§4.4: человеческий темп — мгновенный ответ невозможен', async () => {
  const { humanPace } = await import('../lib/antiCluster.js')
  const p = humanPace('Короткий ответ', 200)
  assert.ok(p.readMs >= 3000, 'меньше трёх секунд на чтение — сигнатура бота')
  const long = humanPace(Array(100).fill('слово').join(' '), 0)
  assert.ok(long.typeMs > 100000, '100 слов нельзя напечатать за секунду')
})

test('§4.4: один аккаунт не работает в пяти чатах параллельно', async () => {
  const { parallelChatsGate } = await import('../lib/antiCluster.js')
  assert.equal(parallelChatsGate(1).ok, true)
  assert.equal(parallelChatsGate(2).ok, false, 'у человека не десять рук')
})

test('§4.4: пачка с одного прокси — предупреждение о кластере', async () => {
  const { proxySpreadGate } = await import('../lib/antiCluster.js')
  const one = { a1: 'socks5://1.1.1.1:1080', a2: 'socks5://1.1.1.1:1080', a3: 'socks5://1.1.1.1:1080' }
  assert.equal(proxySpreadGate(one, ['a1', 'a2', 'a3']).ok, false)
  const spread = { a1: 'socks5://1.1.1.1:1080', a2: 'socks5://2.2.2.2:1080' }
  assert.equal(proxySpreadGate(spread, ['a1', 'a2']).ok, true)
})

test('§4.4: прямое подключение кластером не считается', async () => {
  const { proxySpreadGate } = await import('../lib/antiCluster.js')
  const direct = { a1: '—', a2: '—', a3: '—', a4: '—' }
  assert.equal(proxySpreadGate(direct, ['a1', 'a2', 'a3', 'a4']).ok, true,
    'это разные домашние IP, а не один шлюз')
})

test('§4.2: распорядок редактируется в ПРОЦЕНТАХ (0–100)', () => {
  // Оператор вводит «80», а не «0.8». Значение >1 однозначно читается как процент:
  // доли больше единицы не бывает, а процента меньше единицы — не бывает на практике.
  const s = normalizeSchedule({ 9: 80, 10: 100, 11: 0 })
  assert.equal(s[9], 0.8)
  assert.equal(s[10], 1)
  assert.equal(s[11], 0, 'явный ноль — это ноль, а не «не задано»')
  assert.equal(scheduleGate(s, at(10), () => 0.99).ok, true, '100% — проходит любой бросок')
})

test('§4.2: доли 0..1 тоже принимаются — старые записи не ломаются', () => {
  const s = normalizeSchedule({ 9: 0.8, 10: 0.5 })
  assert.equal(s[9], 0.8)
  assert.equal(s[10], 0.5)
})

test('§4.2: пропущенный час берётся из умолчаний, а не считается нулём', () => {
  // Частично заполненная форма иначе молча усыпила бы аккаунт на 23 часа.
  const s = normalizeSchedule({ 9: 50 })
  assert.equal(s[9], 0.5)
  assert.equal(s[13], DEFAULT_SCHEDULE[13])
  assert.equal(Object.keys(s).length, 24, 'таблица всегда полная')
})

test('§4.2: мусор и выход за 0–100 не проходят', () => {
  const s = normalizeSchedule({ 9: 900, 10: -50, 11: 'абв' })
  assert.equal(s[9], 1, 'больше 100% не бывает')
  assert.equal(s[10], 0)
  assert.equal(s[11], DEFAULT_SCHEDULE[11], 'нечисло — берём умолчание, не ноль')
})

test('§4.2: проценты возвращаются обратно без потерь', () => {
  const p = scheduleToPercent(normalizeSchedule({ 9: 85, 14: 40 }))
  assert.equal(p[9], 85)
  assert.equal(p[14], 40)
})

test('§4.4: у каждого аккаунта СВОЙ распорядок — иначе ферма видна по синхронности', () => {
  const ids = ['acc_a1', 'acc_b2', 'acc_c3', 'acc_d4', 'acc_e5', 'acc_f6']
  const shapes = new Set(ids.map((id) => JSON.stringify(scheduleForAccount(id))))
  assert.ok(shapes.size >= 3, `48 профилей с одной кривой оживают в одну минуту; разных: ${shapes.size}`)
})

test('§4.4: личный распорядок стабилен — аккаунт не меняет режим сна при рестарте', () => {
  assert.deepEqual(scheduleForAccount('acc_a1'), scheduleForAccount('acc_a1'))
})

test('§4.4: сдвиг не превращает рабочий день в мёртвый', () => {
  // Разброс — это ±2 часа и амплитуда, а не «выключить аккаунт». Днём он обязан работать.
  for (const id of ['acc_a1', 'acc_b2', 'acc_c3', 'acc_d4']) {
    const s = scheduleForAccount(id)
    const day = [10, 11, 12, 13, 14, 15, 16].map((h) => s[h])
    assert.ok(Math.max(...day) >= 0.5, `${id}: днём максимум ${Math.max(...day)} — аккаунт почти мёртв`)
  }
})

/**
 * Профиль усталости должен ДОЕЗЖАТЬ до формы (правка 18.08).
 *
 * Список активности отдавал только `threshold`, поэтому окно «Усталость и отдых»
 * рисовало умолчания 15/45/5 при каждом открытии. Пользователь читал это как «настройки
 * слетели после деплоя», а повторное «Применить» действительно затирало заданное.
 */
test('listActivity отдаёт весь профиль, а не один порог', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatigue-list-'))
  process.env.ACCOUNT_ACTIVITY_FILE = path.join(dir, 'activity.json')
  const A = await import(`../accountActivity.js?fatigue-list=${Date.now()}`)

  await A.setActivityProfile(['acc_1'], { profile: { threshold: 40, restMinutes: 120 } })
  const map = await A.listActivity()

  assert.equal(map.acc_1.threshold, 40)
  assert.equal(map.acc_1.restMinutes, 120, 'без этого поля форма покажет умолчание вместо заданного')
})

test('профили аккаунтов независимы: свой порог у каждого', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatigue-each-'))
  process.env.ACCOUNT_ACTIVITY_FILE = path.join(dir, 'activity.json')
  const A = await import(`../accountActivity.js?fatigue-each=${Date.now()}`)

  await A.setActivityProfile(['acc_a'], { profile: { threshold: 5, restMinutes: 30, recoveryPerHour: 2 } })
  await A.setActivityProfile(['acc_b'], { profile: { threshold: 50, restMinutes: 300, recoveryPerHour: 20 } })
  const map = await A.listActivity()

  assert.equal(map.acc_a.threshold, 5)
  assert.equal(map.acc_b.threshold, 50, 'настройка одного аккаунта не должна перетирать соседний')
  assert.equal(map.acc_a.restMinutes, 30)
  assert.equal(map.acc_b.restMinutes, 300)
})

/**
 * Усталость — ЦЕЛОЕ число действий (правка 18.08).
 *
 * В интерфейсе висело «2.53/1» и «0.8/1»: восстановление размазывалось непрерывно, и
 * аккаунт с 0.8 формально не дотягивал до порога 1 — уходил делать ещё одно действие,
 * хотя одно уже сделал. Счёт должен быть человеческим: сделал действие — единица.
 */
test('усталость целая и не выше порога', () => {
  const H = 3600000
  const now = 1_000_000_000
  const profile = { threshold: 1, restMinutes: 45, recoveryPerHour: 5 }

  // Прошло ~2 минуты после действия: сырое значение 0.83, показываем целую единицу.
  const soon = currentFatigue({ fatigue: 1, lastActionAt: now - 0.04 * H }, profile, now)
  assert.equal(soon, 1)
  assert.equal(Number.isInteger(soon), true, 'в интерфейсе не должно быть «0.8 из 1»')

  // Старые записи с раздутым счётчиком показываются по потолку: «3 из 1» — бессмыслица.
  assert.equal(currentFatigue({ fatigue: 3, lastActionAt: now }, profile, now), 1)
})

test('порог 1: после одного действия аккаунт уходит на отдых, а не делает второе', () => {
  const now = 1_000_000_000
  const profile = { threshold: 1, restMinutes: 45, recoveryPerHour: 5 }

  const patch = applyAction({}, profile, now)
  assert.equal(patch.fatigue, 1)
  assert.ok(patch.restUntil > now, 'достигнут порог — назначен обязательный отдых')

  const gate = fatigueGate({ ...patch }, profile, now + 60_000)
  assert.equal(gate.ok, false, 'второе действие подряд при пороге 1 недопустимо')
})

test('усталость целая и при больших порогах', () => {
  const H = 3600000
  const now = 1_000_000_000
  const profile = { threshold: 15, restMinutes: 45, recoveryPerHour: 5 }
  for (const hoursAgo of [0.1, 0.37, 1.2, 2.9]) {
    const f = currentFatigue({ fatigue: 12, lastActionAt: now - hoursAgo * H }, profile, now)
    assert.equal(Number.isInteger(f), true, `дробь при ${hoursAgo} ч: ${f}`)
  }
})

/**
 * Отдых и восстановление — РАЗНЫЕ вещи, но раньше они спорили (правка 18.08).
 *
 * Оператор ставил «порог 1, отдых 3 минуты, восстановление 1/час» и ожидал: одно
 * действие → три минуты паузы → снова в строй. На деле после трёх минут аккаунт
 * оставался «устал 1 из 1» ещё почти час: обязательный отдых счётчик не обнулял, а
 * восстановление 1/час съедало единицу только за час.
 */
test('отбытый обязательный отдых обнуляет усталость', () => {
  const M = 60000
  const now = 1_000_000_000
  const profile = { threshold: 1, restMinutes: 3, recoveryPerHour: 1 }

  const state = applyAction({}, profile, now)
  assert.equal(fatigueGate(state, profile, now + 1 * M).ok, false, 'внутри отдыха работать нельзя')
  assert.equal(fatigueGate(state, profile, now + 4 * M).ok, true, 'отдых отбыт — аккаунт снова в строю')
  assert.equal(currentFatigue(state, profile, now + 4 * M), 0, 'счётчик обнулён отдыхом, а не ждёт час восстановления')
})

test('восстановление работает в обычных перерывах, когда до порога не дошли', () => {
  const H = 3600000
  const now = 1_000_000_000
  const profile = { threshold: 15, restMinutes: 45, recoveryPerHour: 5 }
  assert.equal(currentFatigue({ fatigue: 5, lastActionAt: now - 1 * H }, profile, now), 0)
  assert.equal(currentFatigue({ fatigue: 12, lastActionAt: now - 1 * H }, profile, now), 7)
})

test('после отдыха новое действие снова копит усталость', () => {
  const M = 60000
  const now = 1_000_000_000
  const profile = { threshold: 2, restMinutes: 3, recoveryPerHour: 1 }

  let state = applyAction({}, profile, now)                      // 1
  state = { ...state, ...applyAction(state, profile, now + M) }  // 2 → отдых
  assert.ok(state.restUntil > now + M)

  const afterRest = now + 10 * M
  assert.equal(currentFatigue(state, profile, afterRest), 0)
  const again = applyAction(state, profile, afterRest)
  assert.equal(again.fatigue, 1, 'счёт начинается заново, а не продолжает старый')
})

/**
 * Срок возврата в строй (правка 18.08): карточка писала «устал», но не говорила, до
 * каких пор — и оператор шёл сбрасывать усталость руками, хотя ждать оставалось минуты.
 */
test('freeAt: во время перерыва — его конец', () => {
  const M = 60000
  const now = 1_000_000_000
  const profile = { threshold: 1, restMinutes: 3, recoveryPerHour: 1 }
  const state = applyAction({}, profile, now)
  assert.equal(freeAt(state, profile, now + M), state.restUntil)
})

test('freeAt: порог понизили после работы — ждём восстановления под порог', () => {
  const H = 3600000
  const now = 1_000_000_000
  // Было «3 из 15», порог сменили на 1: перерыв не назначался, но работать нельзя.
  const state = { fatigue: 3, lastActionAt: now, restUntil: 0 }
  const profile = { threshold: 1, restMinutes: 20, recoveryPerHour: 1 }
  // Счётчик капается порогом («3 из 1» показывается как 1), поэтому восстановлению
  // нужно снять одну единицу, а не три: час при 1 ед./час.
  assert.equal(Math.round((freeAt(state, profile, now) - now) / H), 1)
  // Восстановление выключено — остаётся один отдых по профилю.
  const noRec = { threshold: 1, restMinutes: 20, recoveryPerHour: 0 }
  assert.equal(Math.round((freeAt(state, noRec, now) - now) / 60000), 20)
})

test('freeAt: аккаунт в строю — ноль', () => {
  const now = 1_000_000_000
  assert.equal(freeAt({ fatigue: 0 }, DEFAULT_FATIGUE, now), 0)
  assert.equal(freeAt({ fatigue: 3, lastActionAt: now }, DEFAULT_FATIGUE, now), 0, 'порог 15 — три действия не помеха')
})

/**
 * Пропуск по распорядку: два РАЗНЫХ случая (правка 19.08).
 *
 * Прогон 19.08 показал в логах подряд: «Пропуск: не попал в вероятность 67% для 11:00» и
 * следом «Все аккаунты заняты отдыхом — ждём 28 мин». Оба сообщения врали: аккаунт не
 * отдыхал, а не повезло с броском кубика — и ждать до конца часа ради 67% бессмысленно,
 * следующий бросок может выпасть удачно через минуту.
 */
test('час закрыт (0%) — ждём до следующего часа', () => {
  const now = at(11, 20)
  const g = scheduleGate({ 11: 0 }, now, () => 0.5)
  assert.equal(g.ok, false)
  const left = Math.round((g.until - now) / 60000)
  assert.equal(left, 40, 'до 12:00 остаётся 40 минут')
})

test('не повезло с броском — короткий повтор, а не остаток часа', () => {
  const now = at(11, 20)
  const g = scheduleGate({ 11: 0.67 }, now, () => 0.99)
  assert.equal(g.ok, false)
  assert.match(g.reason, /распорядок дня/, 'в тексте должно быть видно, что это распорядок, а не «вероятность» из настроек модуля')
  const wait = g.until - now
  assert.ok(wait > 0 && wait < 40 * 60000, 'ждём повтор, а не остаток часа (до 12:00 тут 40 мин)')
})

/**
 * Срок повтора считается от ШАНСА ЧАСА (просьба владельца 21.08: «выставить такую
 * задержку, чтобы при повторном дёргании он уже был активным»). Фиксированная минута
 * была одинаковой и для 89%, и для 5%: в первом случае аккаунт зря стоял минуту, во
 * втором воркер молотил вхолостую 12 раз в час.
 */
test('повтор броска зависит от шанса часа', () => {
  const now = at(11, 0)
  const часто = rollRetryMs(0.89, now)
  const редко = rollRetryMs(0.1, now)
  assert.ok(часто < 15000, `при 89% ждать почти нечего, получили ${часто} мс`)
  assert.ok(редко > часто * 10, 'при 10% ждать заметно дольше')
  // Дальше конца часа ждать бессмысленно: там уже другой шанс.
  assert.ok(rollRetryMs(0.01, at(11, 50)) <= 10 * 60000 + 1, 'не дольше остатка часа')
  // И не крутимся вхолостую при почти стопроцентном шансе.
  assert.ok(rollRetryMs(1, now) >= 5000, 'минимум пять секунд между попытками')
})

test('попал в вероятность — работаем', () => {
  const g = scheduleGate({ 11: 0.67 }, at(11, 20), () => 0.1)
  assert.equal(g.ok, true)
})

/**
 * Вопрос владельца 21.08: «восстановление почему только за час, почему нету в минутах?»
 * Скорость «единиц в час» целым числом не выражала ни «единицу за 20 минут», ни «за
 * полтора часа», поэтому параметр стал ПЕРИОДОМ на одну единицу.
 */
test('восстановление задаётся периодом — минуты и часы одинаково выразимы', async () => {
  const { recoveryEveryMs, currentFatigue } = await import('../lib/accountFatigue.js')
  const MIN = 60_000

  // Двадцать минут на единицу — прежней шкалой это было 3 ед./час, но «полторы» бы уже не вышло.
  assert.equal(recoveryEveryMs({ recoveryEveryMs: 20 * MIN }), 20 * MIN)
  // Полтора часа на единицу — по-старому 0.67 ед./час, целым числом невыразимо совсем.
  assert.equal(recoveryEveryMs({ recoveryEveryMs: 90 * MIN }), 90 * MIN)

  const now = 1_700_000_000_000
  const every20 = { threshold: 15, restMinutes: 45, recoveryEveryMs: 20 * MIN }
  // Час простоя при 20 минутах на единицу — минус три.
  assert.equal(currentFatigue({ fatigue: 10, lastActionAt: now - 60 * MIN }, every20, now), 7)
  // Девятнадцать минут — ещё ничего не стаяло: счётчик целый, дробей не показываем.
  assert.equal(currentFatigue({ fatigue: 10, lastActionAt: now - 19 * MIN }, every20, now), 10)
})

test('старые профили с «единиц в час» читаются как прежде', async () => {
  const { recoveryEveryMs } = await import('../lib/accountFatigue.js')
  // Профили аккаунтов лежат в базе со старым полем — переписывать их миграцией ради
  // смены единиц измерения незачем, пересчёта на чтении достаточно.
  assert.equal(recoveryEveryMs({ recoveryPerHour: 5 }), 12 * 60_000, '5 ед./час = 12 мин на единицу')
  assert.equal(recoveryEveryMs({ recoveryPerHour: 1 }), 60 * 60_000)
  // Выключенное восстановление должно остаться выключенным, а не подхватить умолчание.
  assert.equal(recoveryEveryMs({ recoveryPerHour: 0 }), 0)
})

/**
 * Прогон 19.08: в распорядке стояло 87% на 11:00, а в логе задачи — «не выпало 76%».
 * Причина не в вероятности, а в ЧАСЕ: распорядок задаёт человек в своём времени
 * (киевском), а сервер брал свой локальный час — на проде UTC, на три часа позади.
 * В 11:00 по Киеву читалась ячейка 8:00.
 */
test('распорядок читается по киевскому часу, а не по часу сервера', () => {
  // 09:30 UTC = 12:30 по Киеву летом. Ячейки специально разные, чтобы подмена была видна.
  const at = Date.parse('2026-08-19T09:30:00Z')
  const schedule = { ...DEFAULT_SCHEDULE, 9: 0.1, 12: 0.9 }

  assert.equal(scheduleHour(at, 'Europe/Kyiv'), 12, 'берём киевский час')
  assert.equal(scheduleHour(at, 'UTC'), 9, 'в UTC это была бы другая ячейка')

  const g = scheduleGate(schedule, at, () => 0.5)
  assert.equal(g.chance, 0.9, 'шанс из ячейки 12:00, а не из 9:00')
  assert.ok(g.ok, '0.5 попадает в 90%')
})

test('шанс распорядка не инвертирован: 87% пропускают почти всегда', () => {
  // Заказчик подозревал обратный порядок («89% не согласна»). Проверяем прямо:
  // бросок 0.5 при шансе 87% должен ПРОЙТИ, а 0.95 — нет.
  const at = Date.parse('2026-08-19T09:30:00Z')
  const schedule = { ...DEFAULT_SCHEDULE, 12: 0.87 }
  assert.ok(scheduleGate(schedule, at, () => 0.5).ok, '0.5 < 0.87 — работаем')
  assert.ok(!scheduleGate(schedule, at, () => 0.95).ok, '0.95 > 0.87 — пропуск')
})

/**
 * Жалоба владельца 25.08: «следующая попытка не трекается — он сразу три раза запустил,
 * пока не выпало положительно».
 *
 * Бросок распорядка был без памяти: на каждом круге (а круг это секунды) аккаунт получал
 * новый шанс. Строка «следующая попытка через 45 с» оказывалась пустым обещанием, но
 * хуже другое — распорядок терял смысл: профиль, активный на 44%, при десятке бросков
 * подряд выходил на работу почти всегда.
 */
test('неудачный бросок распорядка держится до срока, а не бросается заново', async (t) => {
  const os = await import('os')
  const path = await import('path')
  const dir = path.join(os.tmpdir(), `act-hold-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await (await import('fs/promises')).mkdir(dir, { recursive: true })
  process.env.ACCOUNT_ACTIVITY_FILE = path.join(dir, 'activity.json')

  const { canWorkNow, setActivityProfile, clearScheduleHolds } = await import('../accountActivity.js')
  t.after(() => clearScheduleHolds())
  clearScheduleHolds()

  /*
   * Аккаунт активен на 50% В ЛЮБОЙ ЧАС — чтобы решал бросок, а не время суток.
   *
   * Раньше здесь стояло `{ schedule: { hours } }`, где `hours` — массив. Такой формат
   * `normalizeSchedule` не понимает: он читает ключи `0`…`23`, не находит их и берёт
   * распорядок ПО УМОЛЧАНИЮ. Тест при этом продолжал проходить — но проверял не то, что
   * написано, а умолчание, в котором с 2 до 5 ночи стоит ноль. В эти часы «удачный
   * бросок после срока» пройти не может в принципе, и прогон краснел по времени суток:
   * днём зелено, ночью нет. Формат исправлен — теперь распорядок и правда ровный (MR-290).
   */
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 50]))
  await setActivityProfile(['acc_hold'], { schedule: hours, spread: false })

  const t0 = Date.now()
  // Первый бросок делаем заведомо неудачным.
  const miss = await canWorkNow('acc_hold', t0, () => 0.99)
  assert.equal(miss.ok, false, 'бросок 99 против 50% должен пролететь мимо')
  assert.ok(miss.until > t0, 'должен назвать срок следующей попытки')

  // Дальше на этом же круге кубик бросать НЕЛЬЗЯ, даже если он выпал бы удачно.
  const again = await canWorkNow('acc_hold', t0 + 1000, () => 0.01)
  assert.equal(again.ok, false, 'до срока аккаунт не должен получать новый шанс')
  assert.equal(again.until, miss.until, 'срок не переезжает от повторных обращений')
  assert.equal(again.cached, true, 'повтор помечен — воркер не пишет ту же строку в лог')

  // А когда срок вышел — бросок снова настоящий.
  const after = await canWorkNow('acc_hold', miss.until + 1, () => 0.01)
  assert.equal(after.ok, true, 'после срока удачный бросок должен проходить')
})

test('logTime пишет время в зоне распорядка, а не в зоне сервера (27.08)', async () => {
  // Прод стоит в UTC, владелец в Киеве. Из-за форматирования по зоне сервера в логе
  // рассылки в 00:18 стояло «все аккаунты отдыхают, вернутся в 21:19» — обещание
  // вернуться в прошлое. Та же ошибка была у спамблока: «выведен до 21:11».
  const { logTime } = await import('../lib/accountFatigue.js')
  const t = Date.parse('2026-08-26T21:19:00Z') // 00:19 следующего дня по Киеву

  assert.equal(logTime(t), '00:19')
  assert.match(logTime(t, true), /27\.08\.2026/)
})
