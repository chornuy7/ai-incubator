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

test('idleWaitPlan: длинное окно не ждём — завершаем задачу честно', () => {
  const now = 1_000_000
  assert.deepEqual(idleWaitPlan(now + 3 * 3600_000, now), { wait: false }, 'три часа ожидания — это зависшая задача')
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
