import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function fresh() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-'))
  process.env.WORKLOG_FILE = path.join(dir, 'worklog.json')
  return import('../workLog.js?t=' + Date.now() + Math.random())
}

test('clockIn идемпотентен, clockOut закрывает и считает длительность', async () => {
  const w = await fresh()
  const t0 = 1_000_000
  const a = await w.clockIn('u1', t0)
  assert.equal(a.end, null)
  const again = await w.clockIn('u1', t0 + 5000) // уже открыта — та же сессия
  assert.equal(again.id, a.id)

  const closed = await w.clockOut('u1', t0 + 60_000)
  assert.equal(closed.end, t0 + 60_000)
  assert.equal(closed.durationMs, 60_000)

  assert.equal(await w.clockOut('u1', t0 + 70_000), null) // нечего закрывать
  delete process.env.WORKLOG_FILE
})

test('workSummary: сегодня/неделя + открытая сессия «вживую»', async () => {
  const w = await fresh()
  const now = 10_000_000_000
  // закрытая сессия сегодня на 30 минут
  await w.clockIn('u1', now - 40 * 60_000)
  await w.clockOut('u1', now - 10 * 60_000)
  // открытая сессия сейчас 5 минут
  await w.clockIn('u1', now - 5 * 60_000)

  const s = await w.workSummary('u1', now)
  assert.equal(s.open, true)
  assert.ok(s.todayMs >= 34 * 60_000, `todayMs=${s.todayMs}`) // 30 + ~5 живой
  assert.ok(s.weekMs >= s.todayMs)
  delete process.env.WORKLOG_FILE
})

test('summariesFor по нескольким юзерам', async () => {
  const w = await fresh()
  const now = 5_000_000_000
  await w.clockIn('a', now - 20 * 60_000)
  await w.clockOut('a', now)
  const all = await w.summariesFor(['a', 'b'], now)
  assert.ok(all.a.todayMs >= 20 * 60_000)
  assert.equal(all.b.todayMs, 0)
  assert.equal(all.b.open, false)
  delete process.env.WORKLOG_FILE
})
