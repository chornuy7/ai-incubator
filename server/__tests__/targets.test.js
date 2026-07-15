import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededTarget, resolveTotalTarget } from '../lib/targets.js'

test('seededTarget: детерминизм и границы', () => {
  const a = seededTarget(0, 10, 'task_x')
  const b = seededTarget(0, 10, 'task_x')
  assert.equal(a, b) // детерминизм по seed
  assert.ok(a >= 0 && a <= 10)
  assert.equal(seededTarget(5, 5, 'z'), 5)
})

test('resolveTotalTarget: защита от «тихого нуля» при положительном max', () => {
  // ищем task-id, на котором seededTarget(0, max) даёт 0 — их много
  let zeroSeed = null
  for (let i = 0; i < 200 && zeroSeed === null; i++) {
    if (seededTarget(0, 3, 'seed_' + i) === 0) zeroSeed = 'seed_' + i
  }
  assert.ok(zeroSeed, 'нашли seed с нулём')
  // без защиты был бы 0 → задача молча ничего не делает; теперь минимум 1
  const t = resolveTotalTarget({ maxActions: 3 }, { id: zeroSeed })
  assert.ok(t >= 1, `цель ${t} должна быть >= 1`)
  // если max=0 (безлимит/по времени) — 0 допустим
  assert.equal(resolveTotalTarget({ maxActions: 0 }, { id: zeroSeed }), 0)
})
