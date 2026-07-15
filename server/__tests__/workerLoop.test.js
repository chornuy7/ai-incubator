import { test } from 'node:test'
import assert from 'node:assert/strict'
import { warmingPace, trackIdlePass } from '../lib/workerLoop.js'

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
