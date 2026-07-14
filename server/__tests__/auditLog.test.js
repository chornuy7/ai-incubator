import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

test('appendAudit: ротация обрезает файл до KEEP_LINES (A2)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-'))
  const file = path.join(dir, 'audit.jsonl')
  process.env.AUDIT_LOG_FILE = file
  process.env.AUDIT_MAX_BYTES = '1' // любой append превышает → триггерит ротацию
  process.env.AUDIT_KEEP_LINES = '3'
  // свежий инстанс модуля с этим env (обходим ESM-кеш query-строкой)
  const mod = await import('../lib/auditLog.js?rot=' + Date.now())
  for (let i = 0; i < 10; i++) await mod.appendAudit({ action: 'x', code: String(i) })
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 3, 'должно остаться ровно KEEP_LINES строк')
  const back = await mod.readAudit()
  assert.equal(back.length, 3)
  assert.equal(back[0].code, '9', 'новые записи сверху')
  delete process.env.AUDIT_LOG_FILE
  delete process.env.AUDIT_MAX_BYTES
  delete process.env.AUDIT_KEEP_LINES
})
