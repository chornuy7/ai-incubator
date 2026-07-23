/**
 * A3.1–A3.3 (SPEC §1.2, §2.6, решение звонка 22.07): тон/ограничения/дожим — свойства
 * АГЕНТА, а не Цели, и агент выбирается на строке модуля кампании.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCampaignPlan } from '../lib/campaign.js'
import { normalizeCampaign } from '../campaigns.js'
import { normalizeGoal } from '../goals.js'
import { followUpDecision } from '../lib/followUp.js'

// ── A3.1: цель больше не носит в себе манеру общения ─────────────────────
test('A3.1: normalizeGoal не сохраняет тон, ограничения и дожим', () => {
  const g = normalizeGoal({
    name: 'Продвижение',
    toneOfVoice: 'на «ты», коротко',
    restrictions: 'не обещать доход',
    followUp: { enabled: true, limit: 3 },
  })
  assert.equal(g.toneOfVoice, undefined, 'тон — свойство агента')
  assert.equal(g.restrictions, undefined)
  assert.equal(g.followUp, undefined)
  assert.equal(g.name, 'Продвижение', 'а сама цель на месте')
})

// ── A3.2: агент живёт на строке модуля ───────────────────────────────────
test('A3.2: moduleAgents хранит агента для каждого модуля', () => {
  const c = normalizeCampaign({
    name: 'Кампания',
    modules: ['neuro-commenting', 'mass-react'],
    moduleAgents: { 'neuro-commenting': 'ag_hvalyat', 'mass-react': 'ag_sporyat' },
  })
  assert.deepEqual(c.moduleAgents, { 'neuro-commenting': 'ag_hvalyat', 'mass-react': 'ag_sporyat' })
})

test('A3.2: агент модуля, которого нет в кампании, отбрасывается', () => {
  const c = normalizeCampaign({
    name: 'Кампания',
    modules: ['neuro-commenting'],
    moduleAgents: { 'neuro-commenting': 'ag_1', 'mass-react': 'ag_мусор' },
  })
  assert.deepEqual(c.moduleAgents, { 'neuro-commenting': 'ag_1' },
    'иначе в данных копился бы мусор от переключений в форме')
})

// ── A3.3: разные агенты доезжают до РАЗНЫХ задач одной кампании ──────────
test('A3.3: «500 хвалят / 500 спорят» — каждый модуль стартует со своим агентом', () => {
  const plan = buildCampaignPlan({
    goalId: 'g1',
    accountIds: ['a1', 'a2'],
    targets: ['@c'],
    settings: { maxActions: 10 },
    modules: [
      { moduleKey: 'neuro-commenting', settings: { agentId: 'ag_hvalyat' } },
      { moduleKey: 'mass-react', settings: { agentId: 'ag_sporyat' } },
    ],
  })
  const byKey = Object.fromEntries(plan.map((p) => [p.moduleKey, p.settings]))
  assert.equal(byKey['neuro-commenting'].agentId, 'ag_hvalyat')
  assert.equal(byKey['mass-react'].agentId, 'ag_sporyat')
  assert.equal(byKey['neuro-commenting'].maxActions, 10, 'общие лимиты кампании не потерялись')
})

// ── дожим читается у агента, а для старых задач — у цели ─────────────────
test('дожим берётся у агента', () => {
  const lead = { status: 'target' }
  const agent = { followUp: { enabled: true, limit: 2 } }
  assert.equal(followUpDecision(lead, agent, 0, true).mode, 'follow-up')
})

test('дожим: задача без агента продолжает работать по цели (legacy)', () => {
  const lead = { status: 'target' }
  const goal = { followUp: { enabled: true, limit: 2 } }
  assert.equal(followUpDecision(lead, goal, 0, true).mode, 'follow-up')
})

test('дожим выключен — молчим, что бы ни пришло', () => {
  assert.equal(followUpDecision({ status: 'closed' }, { followUp: { enabled: false } }, 0, true).mode, 'skip')
})
