import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDue } from '../campaignSchedules.js'

const DAY = 24 * 60 * 60 * 1000

test('isDue: one-time / daily / enabled / время', () => {
  const now = 1_000_000
  // выключено
  assert.equal(isDue({ enabled: false, runAt: now - 1, repeat: 'none', lastRunAt: null }, now), false)
  // ещё не время
  assert.equal(isDue({ enabled: true, runAt: now + 1, repeat: 'none', lastRunAt: null }, now), false)
  // one-time, время пришло, не запускалась → due
  assert.equal(isDue({ enabled: true, runAt: now - 1, repeat: 'none', lastRunAt: null }, now), true)
  // one-time уже запускалась → не due
  assert.equal(isDue({ enabled: true, runAt: now - 1, repeat: 'none', lastRunAt: now - 100 }, now), false)
  // daily: запускалась <24ч назад → не due
  assert.equal(isDue({ enabled: true, runAt: now - DAY, repeat: 'daily', lastRunAt: now - 1000 }, now), false)
  // daily: запускалась >24ч назад → due
  assert.equal(isDue({ enabled: true, runAt: now - 2 * DAY, repeat: 'daily', lastRunAt: now - DAY - 1 }, now), true)
  // daily: ещё не запускалась, время пришло → due
  assert.equal(isDue({ enabled: true, runAt: now - 1, repeat: 'daily', lastRunAt: null }, now), true)
})

test('CRUD + markRun + tick на изолированном файле', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csch-'))
  process.env.CAMPAIGN_SCHEDULES_FILE = path.join(dir, 'sch.json')
  const m = await import('../campaignSchedules.js?crud=' + Date.now())

  const now = 5_000_000
  const s = await m.createSchedule({ name: 'Тест', body: { modules: [{ moduleKey: 'neuro-commenting' }] }, runAt: now - 1000, repeat: 'none' })
  assert.ok(s.id.startsWith('csch_'))
  assert.equal((await m.listSchedules()).length, 1)

  // тик с фейковым runner — one-time запись срабатывает и выключается
  let calls = 0
  const runner = async (body) => { calls++; assert.equal(body.initiator, 'scheduler'); return { campaignId: 'camp_x', tasks: [{}, {}] } }
  const fired = await m.campaignScheduleTick(runner, now)
  assert.equal(fired.length, 1)
  assert.equal(calls, 1)
  const after = (await m.listSchedules())[0]
  assert.equal(after.enabled, false) // one-time отработала
  assert.equal(after.lastResult.tasks, 2)

  // повторный тик — уже не запускает
  assert.equal((await m.campaignScheduleTick(runner, now + 1)).length, 0)

  const upd = await m.updateSchedule(s.id, { enabled: true, repeat: 'daily' })
  assert.equal(upd.enabled, true)
  assert.equal(await m.deleteSchedule(s.id), true)
  assert.deepEqual(await m.listSchedules(), [])

  delete process.env.CAMPAIGN_SCHEDULES_FILE
})
