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

test('прогрев: срок в днях разворачивается в точную цель, без жребия (27.08)', async () => {
  // Вопрос владельца: «прогрев исполнился за пару часов, хотя минимальный прогрев 2 дня».
  // Цель бралась жребием из [min, max] и при пустом минимуме могла выпасть крошечной.
  const { resolveTotalTarget } = await import('../lib/targets.js')

  // Так это делает startModuleTask: срок × суточная норма уровня.
  const план = (days, level) => {
    const perDay = [40, 20, 10][level]
    const total = days * perDay
    return { maxActions: total, minActions: total, warmDays: days, warmLevel: level }
  }

  assert.equal(resolveTotalTarget(план(2, 0), { id: 'a' }), 80) // 2 дня быстрым темпом
  assert.equal(resolveTotalTarget(план(2, 2), { id: 'a' }), 20) // 2 дня бережным
  assert.equal(resolveTotalTarget(план(14, 1), { id: 'a' }), 280)

  // Цель не зависит от id задачи: жребия здесь быть не должно.
  assert.equal(resolveTotalTarget(план(7, 1), { id: 'x' }), resolveTotalTarget(план(7, 1), { id: 'y' }))
})

test('без явного минимума цель равна максимуму — заданное число выполняется точно (27.08)', async () => {
  // Владелец: «дал задачу сделать 2 комментария, в итоге сделал 1». Цель бралась жребием
  // из [min, max], а минимум по умолчанию был нулём.
  const { resolveTotalTarget } = await import('../lib/targets.js')

  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    assert.equal(resolveTotalTarget({ maxActions: 2 }, { id }), 2, 'просили 2 — делаем 2')
  }
  // Мейлинг и автопостинг общего числа не шлют вовсе: раньше это был жребий 0..100.
  assert.equal(resolveTotalTarget({}, { id: 'x' }), 100)

  // Диапазон работает, только когда минимум задан РУКАМИ.
  const range = new Set(['a', 'b', 'c', 'd'].map((id) => resolveTotalTarget({ minActions: 1, maxActions: 4 }, { id })))
  assert.ok(range.size > 1, 'явный диапазон по-прежнему даёт разные цели')
})
