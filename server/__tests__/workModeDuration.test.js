import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDurationPeriodMinutes } from '../lib/workModeDuration.js'

test('resolveDurationPeriodMinutes: нет длительности → null', () => {
  assert.equal(resolveDurationPeriodMinutes({}), null)
  assert.equal(resolveDurationPeriodMinutes({ durationMinutes: 0 }), null)
  assert.equal(resolveDurationPeriodMinutes({ durationMinutes: -5 }), null)
  assert.equal(resolveDurationPeriodMinutes({ durationMinutes: 'x' }), null)
})

test('resolveDurationPeriodMinutes: min по уровню защиты, max из настроек', () => {
  // Консервативный(0)=60, Сбалансированный(1)=45, Агрессивный(2)=30
  assert.equal(resolveDurationPeriodMinutes({ durationMinutes: 100, protectionLevel: 0 }).min, 60)
  assert.equal(resolveDurationPeriodMinutes({ durationMinutes: 100, protectionLevel: 2 }).min, 30)
  const r = resolveDurationPeriodMinutes({ durationMinutes: 100, protectionLevel: 2 })
  assert.equal(r.max, 100)
  assert.ok(r.chosen >= 30 && r.chosen <= 100)
})

test('resolveDurationPeriodMinutes: детерминизм по seed (taskId+startedAt)', () => {
  const s = { durationMinutes: 100, protectionLevel: 2 }
  const seed = { taskId: 'task_abc', startedAt: 1700000000000 }
  const a = resolveDurationPeriodMinutes(s, seed)
  const b = resolveDurationPeriodMinutes(s, seed)
  assert.equal(a.chosen, b.chosen) // один seed → один результат
})

test('resolveDurationPeriodMinutes: max меньше min → период схлопывается корректно', () => {
  // durationMinutes=20 < min(60 при уровне 0) → min=20, max=60
  const r = resolveDurationPeriodMinutes({ durationMinutes: 20, protectionLevel: 0 })
  assert.equal(r.min, 20)
  assert.equal(r.max, 60)
  assert.ok(r.chosen >= 20 && r.chosen <= 60)
})
