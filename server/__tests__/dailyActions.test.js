import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dayKey, countFrom, limitReachedFrom } from '../lib/dailyActions.js'

test('dayKey: формат YYYY-MM-DD', () => {
  assert.match(dayKey(0), /^\d{4}-\d{2}-\d{2}$/)
})

test('countFrom / limitReachedFrom (чистые)', () => {
  const now = Date.now()
  const key = dayKey(now)
  const map = { a: { date: key, counts: { comments: 40, joins: 5 } }, b: { date: '2000-01-01', counts: { comments: 999 } } }
  assert.equal(countFrom(map, 'a', 'comments', now), 40)
  assert.equal(countFrom(map, 'a', 'joins', now), 5)
  assert.equal(countFrom(map, 'b', 'comments', now), 0) // старый день → 0
  assert.equal(countFrom(map, 'нет', 'comments', now), 0)
  // лимит comments = 40 (max) → достигнут
  assert.equal(limitReachedFrom(map, 'a', 'comments', now), true)
  assert.equal(limitReachedFrom(map, 'a', 'joins', now), false) // 5 < 20
  assert.equal(limitReachedFrom(map, 'a', 'unknown', now), false) // нет лимита
})

test('incAction: счётчик растёт, сбрасывается новым днём', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-'))
  process.env.DAILY_ACTIONS_FILE = path.join(dir, 'd.json')
  const m = await import('../lib/dailyActions.js?t=' + Date.now())
  const now = Date.now()
  await m.incAction('acc1', 'comments', now)
  await m.incAction('acc1', 'comments', now)
  assert.equal(await m.limitReached('acc1', 'comments', now), false) // 2 < 40
  // накрутим до лимита
  for (let i = 0; i < 38; i++) await m.incAction('acc1', 'comments', now)
  assert.equal(await m.limitReached('acc1', 'comments', now), true) // 40
  // следующий день — сброс
  const tomorrow = now + 24 * 3600 * 1000
  assert.equal(await m.limitReached('acc1', 'comments', tomorrow), false)
  delete process.env.DAILY_ACTIONS_FILE
})
