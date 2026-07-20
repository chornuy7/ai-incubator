import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAILY_LIMITS, PAUSE_RANGES, AUTOSTOP, withinDailyLimit, dailyCap, massStopConfirmSteps, canStopWarming, containsWarming } from '../lib/safetyLimits.js'

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

test('§12 massStopConfirmSteps: усиленное подтверждение на большом объёме', () => {
  assert.equal(massStopConfirmSteps(0), 0) // нечего останавливать
  assert.equal(massStopConfirmSteps(1), 1) // обычное подтверждение
  assert.equal(massStopConfirmSteps(99), 1)
  assert.equal(massStopConfirmSteps(100), 2) // с порога — усиленное
  assert.equal(massStopConfirmSteps(1000), 2)
  // порог настраиваемый (задаёт супер-админ)
  assert.equal(massStopConfirmSteps(10, { doubleConfirmFrom: 5 }), 2)
})

test('§12 canStopWarming: прогрев останавливает только супер-админ', () => {
  assert.equal(canStopWarming(true), true)
  assert.equal(canStopWarming(false), false)
  // защиту можно отключить настройкой
  assert.equal(canStopWarming(false, { warmingSuperAdminOnly: false }), true)
})

test('§12 containsWarming: находит прогрев среди задач', () => {
  assert.equal(containsWarming([{ moduleKey: 'mass-react' }, { moduleKey: 'warming' }]), true)
  assert.equal(containsWarming([{ moduleKey: 'mass-react' }]), false)
  assert.equal(containsWarming([]), false)
  assert.equal(containsWarming(null), false)
})
