import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRuleTarget } from '../automation/store.js'

test('§6 resolveRuleTarget: под кампанией модуль и цель берутся из неё', () => {
  const campaign = { id: 'cmp1', moduleKey: 'warming', accountIds: ['a1', 'a2'], settings: { maxActions: 50 }, goalId: 'g1' }
  const { moduleKey, settings } = resolveRuleTarget({ campaignId: 'cmp1', moduleKey: 'ignored' }, campaign)
  assert.equal(moduleKey, 'warming') // модуль кампании, а не правила
  assert.equal(settings.goalId, 'g1') // цель наследуется
  assert.equal(settings.campaignId, 'cmp1') // задача уносит привязку
  assert.deepEqual(settings.accountIds, ['a1', 'a2']) // закреплённые за кампанией
  assert.equal(settings.maxActions, 50) // пресет кампании
})

test('§6 resolveRuleTarget: настройки правила перекрывают пресет кампании, аккаунты правила — приоритет', () => {
  const campaign = { id: 'cmp1', moduleKey: 'warming', accountIds: ['a1'], settings: { maxActions: 50, probability: 30 } }
  const { settings } = resolveRuleTarget({ campaignId: 'cmp1', accountIds: ['b9'], settings: { maxActions: 5 } }, campaign)
  assert.equal(settings.maxActions, 5) // правило перекрыло
  assert.equal(settings.probability, 30) // остальное из кампании
  assert.deepEqual(settings.accountIds, ['b9']) // явные аккаунты правила
})

test('§6 resolveRuleTarget: без кампании — legacy «голый модуль»', () => {
  const { moduleKey, settings } = resolveRuleTarget({ moduleKey: 'mass-react', accountIds: ['x1'], settings: { limit: 7 } }, null)
  assert.equal(moduleKey, 'mass-react')
  assert.deepEqual(settings.accountIds, ['x1'])
  assert.equal(settings.limit, 7)
  assert.equal(settings.campaignId, undefined) // привязки нет
})

test('§6 resolveRuleTarget: аккаунты из settings, если нет отдельного поля (legacy)', () => {
  const { settings } = resolveRuleTarget({ moduleKey: 'warming', settings: { accountIds: ['s1'] } }, null)
  assert.deepEqual(settings.accountIds, ['s1'])
})
