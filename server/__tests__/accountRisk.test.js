import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAccountRisk } from '../lib/accountRisk.js'

// MR-131: риск считается из ДВУХ независимых осей — прокси и статус/здоровье.

test('MR-131: рабочий прокси + активен → без риска', () => {
  const r = computeAccountRisk({ status: 'active', proxyOk: true, noProxy: false, trustBand: 'high' })
  assert.equal(r.level, 'none')
  assert.equal(r.proxyIssue, false)
  assert.equal(r.statusIssue, false)
})

test('MR-131: мёртвый прокси → высокий риск + конкретика (блокировка + срок)', () => {
  const r = computeAccountRisk({ status: 'active', proxyOk: false, noProxy: false })
  assert.equal(r.level, 'high')
  assert.equal(r.proxyIssue, true)
  assert.match(r.factors.find((f) => f.kind === 'proxy').text, /блокировк/i)
  assert.match(r.factors.find((f) => f.kind === 'proxy').text, /недел/i) // есть срок
})

test('MR-131: без прокси → тоже риск, но отдельный от статуса', () => {
  const r = computeAccountRisk({ status: 'active', proxyOk: true, noProxy: true })
  assert.equal(r.level, 'high')
  assert.equal(r.proxyIssue, true)
  assert.equal(r.statusIssue, false)
})

test('MR-131: прокси ок, но спамблок → риск по статусу, НЕ по прокси (оси разделены)', () => {
  const r = computeAccountRisk({ status: 'spamblock', proxyOk: true, noProxy: false })
  assert.equal(r.level, 'high')
  assert.equal(r.proxyIssue, false)
  assert.equal(r.statusIssue, true)
})

test('MR-131: мёртвый прокси И спамблок → обе оси в факторах', () => {
  const r = computeAccountRisk({ status: 'spamblock', proxyOk: false, noProxy: false })
  assert.equal(r.proxyIssue, true)
  assert.equal(r.statusIssue, true)
  assert.ok(r.factors.length >= 2)
})

test('MR-131: низкий trust при рабочем прокси → средний риск', () => {
  const r = computeAccountRisk({ status: 'active', proxyOk: true, noProxy: false, trustBand: 'low' })
  assert.equal(r.level, 'medium')
})
