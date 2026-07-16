import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyToReturnFromWarming } from '../accountStats.js'

test('readyToReturnFromWarming: только warming + trust>70 (§6)', () => {
  assert.equal(readyToReturnFromWarming('warming', 75), true)
  assert.equal(readyToReturnFromWarming('warming', 71), true)
  assert.equal(readyToReturnFromWarming('warming', 70), false) // строго >70
  assert.equal(readyToReturnFromWarming('warming', 40), false)
  assert.equal(readyToReturnFromWarming('active', 90), false) // не в прогреве — не трогаем
  assert.equal(readyToReturnFromWarming('quarantine', 90), false)
})
