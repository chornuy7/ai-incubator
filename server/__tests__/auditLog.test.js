import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAuditEntry } from '../lib/auditLog.js'

test('buildAuditEntry: дефолты для минимального входа', () => {
  const e = buildAuditEntry({})
  assert.equal(e.action, 'legacy')
  assert.equal(e.module, 'core')
  assert.equal(e.initiator, 'system')
  assert.equal(e.code, '')
  assert.equal(e.reason, '')
  assert.deepEqual(e.scope, {})
  assert.equal(typeof e.id, 'string')
  assert.ok(e.id.length > 0)
  assert.ok(!Number.isNaN(Date.parse(e.ts)), 'ts — валидный ISO')
})

test('buildAuditEntry: проброс полей + опциональные account/meta', () => {
  const e = buildAuditEntry({
    action: 'account.status.change',
    module: 'warming',
    initiator: 'op1',
    code: 'FLOOD_WAIT_420',
    reason: 'flood',
    account: 'acc_1',
    scope: { accounts: ['acc_1'], taskId: 't1' },
    meta: { from: 'active', to: 'floodwait' },
  })
  assert.equal(e.action, 'account.status.change')
  assert.equal(e.module, 'warming')
  assert.equal(e.initiator, 'op1')
  assert.equal(e.account, 'acc_1')
  assert.deepEqual(e.scope, { accounts: ['acc_1'], taskId: 't1' })
  assert.deepEqual(e.meta, { from: 'active', to: 'floodwait' })
})

test('buildAuditEntry: без account/meta — ключи не появляются', () => {
  const e = buildAuditEntry({ action: 'task.start' })
  assert.equal('account' in e, false)
  assert.equal('meta' in e, false)
})
