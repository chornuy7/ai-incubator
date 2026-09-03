/**
 * D5 (SPEC §2.4): кампания принимает намерение словами.
 * Заказчик: «я хочу создать кампанию, а не настроить модуль».
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent } from '../lib/intent.js'

test('D5: намерение раскладывается на модули', () => {
  const r = parseIntent('хочу комментировать крипто-каналы и вести людей в личку')
  const keys = r.modules.map((m) => m.moduleKey)
  assert.ok(keys.includes('neuro-commenting'))
  assert.ok(keys.includes('neuro-dialogs'))
  assert.equal(r.understood, true)
})

test('D5: каналы из текста становятся целями', () => {
  const r = parseIntent('комментировать @cryptoz и https://t.me/nftchat')
  assert.deepEqual(r.targets.sort(), ['cryptoz', 'nftchat'])
})

test('D5: число в намерении — это измеримый результат (§1.3)', () => {
  const r = parseIntent('комментировать каналы, нужно 200 переходов')
  assert.deepEqual(r.result, { amount: 200, unit: 'переход' })
  assert.equal(r.needsLink, true, 'переходы считаются только через отслеживаемую ссылку')
})

test('D5: диалоги без источника людей — предупреждение', () => {
  const r = parseIntent('вести переписку в личке с @chat')
  assert.ok(r.warnings.some((w) => /ответил/.test(w)), 'отвечать будет некому')
})

test('D5: непонятное намерение не выдумывает модули', () => {
  const r = parseIntent('сделай хорошо')
  assert.equal(r.modules.length, 0)
  assert.equal(r.understood, false)
  assert.ok(r.warnings.length, 'молчать тут хуже, чем сказать «не понял»')
})

test('D5: переходы без числа — цель нельзя закрыть', () => {
  const r = parseIntent('комментировать @c и получить переходы')
  assert.ok(r.warnings.some((w) => /сколько/.test(w)))
})

// ── §9.4: дедлайн останавливает УЖЕ ИДУЩУЮ работу, а не только новые запуски ──
test('§9.4: истёкшая цель считается просроченной', async () => {
  const { isGoalExpired } = await import('../goals.js')
  const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  assert.equal(isGoalExpired({ deadline: yesterday }), true)
  assert.equal(isGoalExpired({ deadline: today }), false, 'дедлайн — конец дня включительно')
  assert.equal(isGoalExpired({ deadline: null }), false, 'без дедлайна цель не истекает')
})

// ── §9.12: барьер прогрева одинаков в модуле и в менеджере аккаунтов ──
test('§9.12: остановить прогрев может только супер-админ', async () => {
  const { canStopWarming, WARMING_MODULES } = await import('../lib/safetyLimits.js')
  assert.ok(WARMING_MODULES.has('warming'))
  assert.equal(canStopWarming(false), false, 'обычный оператор не сносит недели работы')
  assert.equal(canStopWarming(true), true)
})
