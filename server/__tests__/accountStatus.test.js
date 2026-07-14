import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS,
  ALL_STATUSES,
  normalizeStatus,
  isRunnable,
  canAssign,
  canTransition,
  buildStatusPatch,
  isStatusExpired,
  nextStatusAfterExpiry,
  TERMINAL,
} from '../lib/accountStatus.js'

test('набор статусов из ТЗ §3.3', () => {
  assert.deepEqual(
    [...ALL_STATUSES].sort(),
    ['active', 'floodwait', 'invalid', 'pause', 'quarantine', 'reauth', 'spamblock', 'warming'].sort(),
  )
})

test('normalizeStatus: legacy → канон', () => {
  assert.equal(normalizeStatus('working'), STATUS.ACTIVE) // working = факт лока, не статус
  assert.equal(normalizeStatus('frozen'), STATUS.QUARANTINE)
  assert.equal(normalizeStatus('valid'), STATUS.ACTIVE)
  assert.equal(normalizeStatus(''), STATUS.ACTIVE)
  assert.equal(normalizeStatus(undefined), STATUS.ACTIVE)
  assert.equal(normalizeStatus('QUARANTINE'), STATUS.QUARANTINE) // регистр
  assert.equal(normalizeStatus('чтотонепонятное'), STATUS.ACTIVE) // fallback
})

test('isRunnable / canAssign', () => {
  assert.equal(isRunnable(STATUS.ACTIVE), true)
  assert.equal(isRunnable('working'), true) // legacy working → active
  for (const s of ['warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid']) {
    assert.equal(isRunnable(s), false, `${s} должен быть нерабочим`)
    assert.equal(canAssign(s), false)
  }
})

test('canTransition: разрешённые и запрещённые', () => {
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.WARMING), true)
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.FLOODWAIT), true)
  assert.equal(canTransition(STATUS.FLOODWAIT, STATUS.ACTIVE), true)
  assert.equal(canTransition(STATUS.SPAMBLOCK, STATUS.QUARANTINE), true)
  assert.equal(canTransition(STATUS.PAUSE, STATUS.ACTIVE), true)
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.ACTIVE), true) // тождественный
  // invalid — терминальный
  assert.equal(canTransition(STATUS.INVALID, STATUS.ACTIVE), false)
  // pause выходит только в active
  assert.equal(canTransition(STATUS.PAUSE, STATUS.WARMING), false)
})

test('TERMINAL содержит invalid', () => {
  assert.equal(TERMINAL.has(STATUS.INVALID), true)
  assert.equal(TERMINAL.has(STATUS.ACTIVE), false)
})

test('buildStatusPatch: валидный переход даёт полный патч', () => {
  const patch = buildStatusPatch({ status: 'active' }, STATUS.FLOODWAIT, {
    code: 'FLOOD_WAIT_420',
    until: 1_000_000,
    initiator: 'system',
  })
  assert.equal(patch.status, STATUS.FLOODWAIT)
  assert.equal(patch.prevStatus, STATUS.ACTIVE)
  assert.equal(patch.statusCode, 'FLOOD_WAIT_420')
  assert.equal(patch.statusReason, 'FLOOD_WAIT_420')
  assert.equal(patch.statusUntil, 1_000_000)
  assert.equal(patch.statusBy, 'system')
  assert.equal(typeof patch.statusSince, 'number')
})

test('buildStatusPatch: legacy-статус нормализуется в prevStatus', () => {
  const patch = buildStatusPatch({ status: 'working' }, STATUS.PAUSE, { initiator: 'op1' })
  assert.equal(patch.prevStatus, STATUS.ACTIVE) // working → active
  assert.equal(patch.status, STATUS.PAUSE)
  assert.equal(patch.statusBy, 'op1')
})

test('buildStatusPatch: недопустимый переход бросает', () => {
  assert.throws(
    () => buildStatusPatch({ status: 'invalid' }, STATUS.ACTIVE),
    /ILLEGAL_TRANSITION:invalid->active/,
  )
})

test('isStatusExpired: только временные статусы и по времени', () => {
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: 100 }, 200), true)
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: 300 }, 200), false)
  assert.equal(isStatusExpired({ status: 'quarantine', statusUntil: 100 }, 200), true)
  assert.equal(isStatusExpired({ status: 'active', statusUntil: 100 }, 200), false) // не временный
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: null }, 200), false) // бессрочный
})

test('nextStatusAfterExpiry: floodwait→prevStatus, quarantine→warming', () => {
  // floodwait истёк → возврат в prevStatus (active)
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 100, prevStatus: 'active' }, 200), STATUS.ACTIVE)
  // floodwait истёк, но prevStatus нерабочий → active
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 100, prevStatus: 'quarantine' }, 200), STATUS.ACTIVE)
  // quarantine истёк → на перепрогрев (не сразу в active), 🔒 §6
  assert.equal(nextStatusAfterExpiry({ status: 'quarantine', statusUntil: 100, prevStatus: 'active' }, 200), STATUS.WARMING)
  // ещё не истёк → null
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 300, prevStatus: 'active' }, 200), null)
  // не временный статус → null
  assert.equal(nextStatusAfterExpiry({ status: 'active' }, 200), null)
})
