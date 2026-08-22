import { test } from 'node:test'
import assert from 'node:assert/strict'
import { warmingPace, trackIdlePass, pickWeightedKey, inActiveWindow, idleWaitPlan, IDLE_WAIT_CAP_MS } from '../lib/workerLoop.js'

test('warmingPace.weights: пропорция действий 40/20/20/10/10', () => {
  const w = warmingPace(1).weights
  assert.equal(w.view, 40)
  assert.equal(w.react, 20)
  assert.equal(w.read, 20)
  assert.equal(w.join + w.ping, 20)
})

test('pickWeightedKey: детерминизм по r + попадание в веса', () => {
  const w = { a: 40, b: 20, c: 40 }
  assert.equal(pickWeightedKey(w, 0), 'a') // начало → первый
  assert.equal(pickWeightedKey(w, 0.99), 'c') // конец → последний
  assert.equal(pickWeightedKey({}, 0.5), '') // нет весов → пусто
  // грубая проверка распределения: r=0.5 при 40/20/40 → 'b' (середина)
  assert.equal(pickWeightedKey(w, 0.5), 'b')
})

test('inActiveWindow: день да, ночь нет', () => {
  assert.equal(inActiveWindow(12), true)
  assert.equal(inActiveWindow(3), false)
  assert.equal(inActiveWindow(23), false) // 23:00 — уже конец окна
  assert.equal(inActiveWindow(9), true)
})

test('warmingPace: 3 уровня — длиннее уровень, медленнее темп, меньше действий', () => {
  const fast = warmingPace(0)
  const norm = warmingPace(1)
  const std = warmingPace(2)
  assert.match(fast.label, /Быстрый/)
  assert.match(norm.label, /Нормальный/)
  assert.match(std.label, /Стандартный/)
  // темп: mul растёт (медленнее), действий/день падает
  assert.ok(fast.mul < norm.mul && norm.mul < std.mul)
  assert.ok(fast.actionsPerDay > norm.actionsPerDay && norm.actionsPerDay > std.actionsPerDay)
  // неизвестный уровень → нормальный
  assert.equal(warmingPace(99).label, norm.label)
})

test('trackIdlePass: сброс при прогрессе, стоп после maxIdle пустых', () => {
  const task = {}
  assert.equal(trackIdlePass(task, true), false) // прогресс → сброс
  assert.equal(task.idlePasses, 0)
  for (let i = 0; i < 4; i++) assert.equal(trackIdlePass(task, false), false)
  assert.equal(trackIdlePass(task, false), true) // 5-й пустой → стоп
})

/**
 * Ожидание вместо преждевременного финиша (правка 18.08).
 *
 * Живой прогон нейрокомментинга: задача сделала 1 действие из 2 и завершилась строкой
 * «отдыхает после нагрузки (ещё 2 мин)». Ждать две минуты честнее, чем отдавать половину.
 * Но ждать до утра из-за ночного распорядка — нет: тогда лучше закончить и сказать когда.
 */
test('idleWaitPlan: короткий отдых пережидаем', () => {
  const now = 1_000_000
  const plan = idleWaitPlan(now + 2 * 60000, now)
  assert.equal(plan.wait, true)
  assert.equal(plan.minutes, 2)
})

test('idleWaitPlan: отдых в несколько часов пережидаем — это штатная работа', () => {
  const now = 1_000_000
  // Правка 19.08: потолок поднят до 12 часов. Аккаунт с отдыхом в три часа — не повод
  // закрывать задачу: время возврата известно точно, и она просто ждёт «в работе».
  assert.equal(idleWaitPlan(now + 3 * 3600_000, now).wait, true)
})

test('idleWaitPlan: ожидание длиннее суток — всё-таки завершаем', () => {
  const now = 1_000_000
  assert.deepEqual(idleWaitPlan(now + 26 * 3600_000, now), { wait: false }, 'сутки ожидания — это уже зависшая задача')
})

test('idleWaitPlan: причина без времени освобождения (лимиты) ожидания не даёт', () => {
  const now = 1_000_000
  assert.deepEqual(idleWaitPlan(0, now), { wait: false })
  assert.deepEqual(idleWaitPlan(now - 5000, now), { wait: false }, 'время уже прошло — ждать нечего')
})

test('idleWaitPlan: ровно на границе потолка ещё ждём', () => {
  const now = 1_000_000
  assert.equal(idleWaitPlan(now + IDLE_WAIT_CAP_MS, now).wait, true)
  assert.equal(idleWaitPlan(now + IDLE_WAIT_CAP_MS + 1, now).wait, false)
})

/**
 * Темп прогрева должен держать обещание уровня (правка 22.08 после замера на живых
 * аккаунтах). «Стандартный» обещает ~10 действий в день, а на деле делал два действия
 * за две минуты: дневная норма отрабатывалась за четверть часа, и «7–14 дней» не значили
 * ничего. Интервал считается от дневного окна активности, а не от паузы между действиями.
 */
test('§8.2 темп прогрева: дневная норма растянута на окно активности', async () => {
  const { WARM_WINDOW_MS, warmingPace, inActiveWindow, msUntilHour } = await import('../lib/workerLoop.js')

  assert.equal(WARM_WINDOW_MS, 14 * 60 * 60 * 1000, 'окно 9:00–23:00 — четырнадцать часов')

  for (const level of [0, 1, 2]) {
    const pace = warmingPace(level)
    const шаг = WARM_WINDOW_MS / pace.actionsPerDay
    assert.ok(шаг >= 20 * 60 * 1000, `уровень «${pace.label}»: шаг ${Math.round(шаг / 60000)} мин — слишком часто для ${pace.actionsPerDay} действий в день`)
    assert.ok(шаг <= 3 * 60 * 60 * 1000, `уровень «${pace.label}»: шаг ${Math.round(шаг / 60000)} мин — норма не уместится в сутки`)
  }

  // Ночью прогрев спит: активность в 4 утра — сама по себе примета фермы.
  assert.equal(inActiveWindow(4), false)
  assert.equal(inActiveWindow(9), true)
  assert.equal(inActiveWindow(22), true)
  assert.equal(inActiveWindow(23), false)

  // Ночная пауза ведёт к утру, а не к «через минуту».
  const доУтра = msUntilHour(9)
  assert.ok(доУтра >= 60 * 60 * 1000 && доУтра <= 24 * 60 * 60 * 1000, `до 9:00 получилось ${Math.round(доУтра / 60000)} мин`)
})
