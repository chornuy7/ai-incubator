import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTrustScore, trustBand, trustRecommendation, extractTrustSignals, accountTrust } from '../lib/trustScore.js'

test('computeTrustScore: идеальный аккаунт → высокий', () => {
  const { score, band } = computeTrustScore({ floodWaits24h: 0, banHistory: 0, cleanActions: 20, ageDays: 30 })
  assert.equal(score, 100)
  assert.equal(band, 'high')
})

test('computeTrustScore: свежий без активности → низкий/средний', () => {
  // 0 флудов (100*.4=40) + 0 банов (100*.25=25) + 0 действий (0) + 0 дней (0) = 65 → mid
  const { score, band } = computeTrustScore({ floodWaits24h: 0, banHistory: 0, cleanActions: 0, ageDays: 0 })
  assert.equal(score, 65)
  assert.equal(band, 'mid')
})

test('computeTrustScore: флуды и баны роняют score', () => {
  // 2 флуда → sFlood=50 (*.4=20); 2 бана → sBans=40 (*.25=10); 10 действий → 50 (*.15=7.5);
  // 15 дней → 50 (*.2=10) = 47.5 → 48 mid
  const { score } = computeTrustScore({ floodWaits24h: 2, banHistory: 2, cleanActions: 10, ageDays: 15 })
  assert.equal(score, 48)
  // 4+ флуда обнуляют флуд-компонент
  const bad = computeTrustScore({ floodWaits24h: 4, banHistory: 3, cleanActions: 0, ageDays: 0, statusPenalty: 60 })
  assert.ok(bad.score < 40)
  assert.equal(bad.band, 'low')
})

test('trustBand: пороги <40 / 40–70 / >70', () => {
  assert.equal(trustBand(39), 'low')
  assert.equal(trustBand(40), 'mid')
  assert.equal(trustBand(70), 'mid')
  assert.equal(trustBand(71), 'high')
})

test('trustRecommendation: действие по полосе', () => {
  assert.equal(trustRecommendation(30).action, 'autostop')
  assert.equal(trustRecommendation(55).action, 'conservative')
  assert.equal(trustRecommendation(90).action, 'pool')
})

test('extractTrustSignals: считает флуды за 24ч, баны, чистые действия', () => {
  const now = 1_000_000_000_000
  const activity = [
    { type: 'action', level: 'success', label: 'Коммент', ts: now - 1000 },
    { type: 'action', level: 'error', label: 'Ошибка', ts: now - 2000 },
    { type: 'event', level: 'warning', label: 'FloodWait 30с', ts: now - 3600 * 1000 }, // в 24ч
    { type: 'event', level: 'warning', label: 'FloodWait старый', ts: now - 48 * 3600 * 1000 }, // вне 24ч
    { type: 'event', level: 'error', label: 'Спамблок аккаунта', ts: now - 5000 },
  ]
  const s = extractTrustSignals({ activity, status: 'quarantine', ageDays: 10, now })
  assert.equal(s.floodWaits24h, 1) // только свежий флуд
  assert.equal(s.banHistory, 1) // спамблок
  assert.equal(s.cleanActions, 1) // success-действие, error не считается
  assert.equal(s.statusPenalty, 40) // quarantine
})

test('accountTrust: сквозной расчёт из активности', () => {
  const now = 1_000_000_000_000
  const t = accountTrust({ activity: [{ type: 'action', level: 'success', label: 'ok', ts: now }], status: 'active', ageDays: 30, now })
  assert.ok(t.score > 0 && t.score <= 100)
  assert.ok(['low', 'mid', 'high'].includes(t.band))
  assert.ok(['autostop', 'conservative', 'pool'].includes(t.action))
})
