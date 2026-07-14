import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueChannels, pickFreeAccountId } from '../channelStats.js'

const H = 3600_000

test('dueChannels: не обновлялось → пора', () => {
  const due = dueChannels([{ id: '1', lastStatsAt: null }], 1000)
  assert.equal(due.length, 1)
})

test('dueChannels: раз в день по умолчанию', () => {
  const now = 100 * H
  const chans = [
    { id: 'fresh', lastStatsAt: now - 2 * H }, // 2ч назад — не пора (период 24ч)
    { id: 'old', lastStatsAt: now - 25 * H }, // 25ч назад — пора
  ]
  const due = dueChannels(chans, now)
  assert.deepEqual(due.map((c) => c.id), ['old'])
})

test('dueChannels: бот в группе → период 1 час', () => {
  const now = 100 * H
  const chans = [
    { id: 'bot-fresh', botInGroup: true, lastStatsAt: now - 30 * 60_000 }, // 30 мин — не пора
    { id: 'bot-old', botInGroup: true, lastStatsAt: now - 90 * 60_000 }, // 1.5ч — пора
  ]
  assert.deepEqual(dueChannels(chans, now).map((c) => c.id), ['bot-old'])
})

test('pickFreeAccountId: только active, не в корзине, не из exclude', () => {
  const meta = {
    a1: { status: 'active' },
    a2: { status: 'warming' },
    a3: { status: 'active', inTrash: true },
    a4: { status: 'active' },
  }
  assert.equal(pickFreeAccountId(meta), 'a1')
  assert.equal(pickFreeAccountId(meta, new Set(['a1'])), 'a4') // a1 занят
  assert.equal(pickFreeAccountId({ x: { status: 'quarantine' } }), null)
})
