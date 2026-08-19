import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Изоляция журнала: свой временный файл, чтобы тест не писал в data/ и не мешал другим.
// env выставляем ДО импорта модуля (FILE читается на его загрузке) — поэтому import динамический.
const TMP = path.join(os.tmpdir(), `action-log-test-${process.pid}.jsonl`)
process.env.ACTION_LOG_FILE = TMP
process.env.DATA_BACKEND = '' // файловый режим, без supabase
const { buildActionEntry, recordAction, readActions, ACTION_TYPES } = await import('../actionLog.js')

test.after(async () => { await fs.rm(TMP, { force: true }) })

test('buildActionEntry: дефолты для минимального входа', () => {
  const e = buildActionEntry({})
  assert.equal(e.type, 'action') // неизвестный/пустой тип → 'action'
  assert.equal(e.status, 'sent')
  assert.equal(e.accountId, '')
  assert.ok(e.id.startsWith('act_'))
  assert.ok(!Number.isNaN(Date.parse(e.ts)), 'ts — валидный ISO')
  assert.deepEqual(e.audience.reactions, {})
  assert.equal(e.audience.repliesCount, 0)
})

test('buildActionEntry: неизвестный тип нормализуется, известный проходит', () => {
  assert.equal(buildActionEntry({ type: 'wat' }).type, 'action')
  for (const t of ACTION_TYPES) assert.equal(buildActionEntry({ type: t }).type, t)
})

test('buildActionEntry: launchId по умолчанию = taskId', () => {
  assert.equal(buildActionEntry({ taskId: 't7' }).launchId, 't7')
  assert.equal(buildActionEntry({ taskId: 't7', launchId: 't7#2' }).launchId, 't7#2')
})

test('buildActionEntry: проброс полей действия', () => {
  const e = buildActionEntry({
    type: 'comment', accountId: 'acc_1', accountName: 'Bot One', target: '@chan',
    objectRef: { postId: 42 }, value: { text: 'Привет' }, moduleKey: 'neuro-commenting',
    taskId: 'nc_1', goalId: 'g1', initiator: 'operator',
  })
  assert.equal(e.type, 'comment')
  assert.equal(e.accountId, 'acc_1')
  assert.equal(e.target, '@chan')
  assert.equal(e.objectRef.postId, 42)
  assert.equal(e.value.text, 'Привет')
  assert.equal(e.moduleKey, 'neuro-commenting')
  assert.equal(e.goalId, 'g1')
})

test('recordAction → readActions: запись и чтение, новые сверху', async () => {
  await recordAction({ type: 'comment', accountId: 'A', target: '@a', value: { text: 'один' }, taskId: 't1', ts: '2026-08-01T10:00:00.000Z' })
  await recordAction({ type: 'reaction', accountId: 'A', target: '@b', value: { emoji: '👍' }, taskId: 't1', ts: '2026-08-02T10:00:00.000Z' })
  await recordAction({ type: 'chat', accountId: 'B', target: '@c', value: { text: 'два' }, taskId: 't2', ts: '2026-08-03T10:00:00.000Z' })

  const all = await readActions({})
  assert.equal(all.length, 3)
  assert.equal(all[0].accountId, 'B', 'новые сверху — последняя запись первой')

  const ofA = await readActions({ accountId: 'A' })
  assert.equal(ofA.length, 2)
  assert.ok(ofA.every((a) => a.accountId === 'A'))

  const reactions = await readActions({ accountId: 'A', type: 'reaction' })
  assert.equal(reactions.length, 1)
  assert.equal(reactions[0].value.emoji, '👍')
})

test('readActions: фильтр по группе и периоду', async () => {
  const byGroup = await readActions({ accountId: 'A', target: '@a' })
  assert.equal(byGroup.length, 1)
  assert.equal(byGroup[0].value.text, 'один')

  // period: только после 2026-08-02 12:00 → останется только запись B (03.08)
  const since = Date.parse('2026-08-02T12:00:00.000Z')
  const recent = await readActions({ since })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].accountId, 'B')
})
