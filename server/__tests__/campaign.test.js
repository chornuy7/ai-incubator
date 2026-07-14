import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitAccounts, buildCampaignPlan } from '../lib/campaign.js'

test('splitAccounts: round-robin, непересекающиеся подмножества', () => {
  const m = splitAccounts(['a', 'b', 'c', 'd', 'e'], ['m1', 'm2'])
  assert.deepEqual(m.m1, ['a', 'c', 'e'])
  assert.deepEqual(m.m2, ['b', 'd'])
  // все аккаунты покрыты, без пересечений
  const all = [...m.m1, ...m.m2].sort()
  assert.deepEqual(all, ['a', 'b', 'c', 'd', 'e'])
})

test('splitAccounts: модулей больше, чем аккаунтов — часть пустые', () => {
  const m = splitAccounts(['a'], ['m1', 'm2', 'm3'])
  assert.deepEqual(m.m1, ['a'])
  assert.deepEqual(m.m2, [])
  assert.deepEqual(m.m3, [])
})

test('splitAccounts: без модулей → пусто', () => {
  assert.deepEqual(splitAccounts(['a', 'b'], []), {})
})

test('buildCampaignPlan: goalId + общие цели + разбивка аккаунтов', () => {
  const plan = buildCampaignPlan({
    goalId: 'g1',
    accountIds: ['a', 'b', 'c'],
    targets: ['@chan'],
    modules: [{ moduleKey: 'neuro-commenting' }, { moduleKey: 'neuro-chatting', targets: ['@grp'] }],
    initiator: 'op1',
  })
  assert.equal(plan.length, 2)
  const nc = plan.find((p) => p.moduleKey === 'neuro-commenting')
  const nch = plan.find((p) => p.moduleKey === 'neuro-chatting')
  assert.deepEqual(nc.settings.accountIds, ['a', 'c']) // round-robin
  assert.deepEqual(nch.settings.accountIds, ['b'])
  assert.equal(nc.settings.goalId, 'g1')
  assert.deepEqual(nc.settings.targets, ['@chan']) // общие
  assert.deepEqual(nch.settings.targets, ['@grp']) // свои переопределяют
  assert.equal(nch.settings.initiator, 'op1')
})
