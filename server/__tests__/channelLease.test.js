import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireChannelLease,
  renewChannelLease,
  releaseChannelLease,
  releaseTaskLeases,
  getChannelLease,
  reconcileLeases,
  _resetLeases,
} from '../lib/channelLease.js'

test('acquire: первый бот берёт, второй получает конфликт (§3.9)', () => {
  _resetLeases()
  assert.equal(acquireChannelLease('ch1', 'botA', 't1', 1000, 0), null)
  const conflict = acquireChannelLease('ch1', 'botB', 't2', 1000, 100)
  assert.ok(conflict)
  assert.equal(conflict.code, 'CHANNEL_LEASED')
  assert.equal(conflict.by, 'botA')
  assert.equal(conflict.taskId, 't1')
})

test('acquire: та же задача перезахватывает (renew через acquire)', () => {
  _resetLeases()
  assert.equal(acquireChannelLease('ch1', 'botA', 't1', 1000, 0), null)
  assert.equal(acquireChannelLease('ch1', 'botA', 't1', 1000, 500), null) // тот же taskId — ок
  assert.equal(getChannelLease('ch1', 500).until, 1500)
})

test('acquire: истёкший lease можно перехватить другим ботом', () => {
  _resetLeases()
  acquireChannelLease('ch1', 'botA', 't1', 1000, 0)
  // now=2000 > until=1000 → истёк
  assert.equal(acquireChannelLease('ch1', 'botB', 't2', 1000, 2000), null)
  assert.equal(getChannelLease('ch1', 2000).botId, 'botB')
})

test('renew: только владелец продлевает', () => {
  _resetLeases()
  acquireChannelLease('ch1', 'botA', 't1', 1000, 0)
  assert.equal(renewChannelLease('ch1', 't2', 1000, 100), false) // чужая задача
  assert.equal(renewChannelLease('ch1', 't1', 1000, 100), true)
  assert.equal(getChannelLease('ch1', 100).until, 1100)
})

test('getChannelLease: истёкший → null', () => {
  _resetLeases()
  acquireChannelLease('ch1', 'botA', 't1', 1000, 0)
  assert.equal(getChannelLease('ch1', 999)?.botId, 'botA')
  assert.equal(getChannelLease('ch1', 1000), null) // until<=now
  assert.equal(getChannelLease('ch1', 1500), null)
})

test('release / releaseTaskLeases', () => {
  _resetLeases()
  acquireChannelLease('ch1', 'botA', 't1', 1000, 0)
  assert.equal(releaseChannelLease('ch1', 't2'), false) // чужая — не снимает
  assert.equal(releaseChannelLease('ch1', 't1'), true)
  assert.equal(getChannelLease('ch1', 0), null)

  acquireChannelLease('ch2', 'botA', 't1', 1000, 0)
  acquireChannelLease('ch3', 'botB', 't1', 1000, 0)
  releaseTaskLeases('t1')
  assert.equal(getChannelLease('ch2', 0), null)
  assert.equal(getChannelLease('ch3', 0), null)
})

test('reconcileLeases: снимает протухшие', () => {
  _resetLeases()
  acquireChannelLease('ch1', 'botA', 't1', 1000, 0)
  acquireChannelLease('ch2', 'botB', 't2', 5000, 0)
  const expired = reconcileLeases(2000) // ch1 истёк (until=1000), ch2 жив (until=5000)
  assert.equal(expired.length, 1)
  assert.equal(expired[0].channelId, 'ch1')
  assert.equal(getChannelLease('ch2', 2000)?.botId, 'botB')
})
