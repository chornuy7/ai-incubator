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
