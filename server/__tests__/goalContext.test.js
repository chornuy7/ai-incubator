import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoalContext } from '../lib/goalContext.js'

test('buildGoalContext: пустой/нет цели → пустая строка (генерация как раньше)', async () => {
  assert.equal(await buildGoalContext(null), '')
  assert.equal(await buildGoalContext(undefined), '')
  assert.equal(await buildGoalContext(''), '')
})

test('buildGoalContext: несуществующая цель → пустая строка (graceful)', async () => {
  const out = await buildGoalContext('goal_does_not_exist_' + Date.now())
  assert.equal(out, '')
})
