import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAILY_LIMITS, PAUSE_RANGES, AUTOSTOP, withinDailyLimit, dailyCap } from '../lib/safetyLimits.js'

test('safetyLimits: значения §6 на месте', () => {
  assert.deepEqual(DAILY_LIMITS.dm, { min: 20, max: 30 })
  assert.equal(DAILY_LIMITS.joins.max, 20)
  assert.deepEqual(PAUSE_RANGES.dm, [90, 300])
  assert.equal(AUTOSTOP.floodWaitStreak, 3)
  assert.ok(AUTOSTOP.hardStatuses.includes('spamblock'))
  assert.equal(AUTOSTOP.mailingMinTrust, 70)
})

test('withinDailyLimit / dailyCap', () => {
  assert.equal(withinDailyLimit('comments', 39), true)
  assert.equal(withinDailyLimit('comments', 40), false) // достигнут max
  assert.equal(withinDailyLimit('joins', 25), false)
  assert.equal(withinDailyLimit('unknown', 999), true) // нет лимита → ок
  assert.equal(dailyCap('reactions'), 200)
})
