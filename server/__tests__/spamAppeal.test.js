/**
 * Апелляция спамблока через @SpamBot — логика диалога с ботом на фейковом клиенте
 * (реальный @SpamBot в юнит-тесте недоступен; проверяем классификацию и шаги).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appealSpamblock } from '../lib/spamAppeal.js'

/**
 * Фейковый GramJS-клиент по сценарию. script — массив сообщений бота; шаг двигают
 * клик по кнопке (invoke) и отправка текста апелляции (sendMessage не /start).
 */
function fakeClient(script) {
  let step = 0
  const at = () => script[Math.min(step, script.length - 1)]
  return {
    getEntity: async () => ({ id: 42 }),
    sendMessage: async (_peer, { message }) => { if (message !== '/start') step++ },
    invoke: async () => { step++ },
    getMessages: async () => {
      const s = at()
      const msg = { id: 1000 + step, message: s.message }
      if (s.buttons) msg.replyMarkup = { rows: [{ buttons: s.buttons.map((b) => ({ text: b.text, data: Buffer.from(b.data) })) }] }
      return [msg]
    },
    disconnect: async () => {},
  }
}
const opts = { waitMs: 1 } // не ждём по 3 секунды

test('чистый аккаунт — state clean, без апелляции', async () => {
  const c = fakeClient([{ message: 'Good news, no limits are currently applied to your account.' }])
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'clean')
  assert.equal(r.appealed, false)
})

test('ограничен + кнопка «это ошибка» → после клика чист → clean, appealed', async () => {
  const c = fakeClient([
    { message: 'Your account is now limited.', buttons: [{ text: 'This is a mistake', data: 'yes' }] },
    { message: 'Great news — no limits will be applied anymore.' },
  ])
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'clean')
  assert.equal(r.appealed, true)
})

test('ограничен + кнопка → бот принял жалобу → appealed', async () => {
  const c = fakeClient([
    { message: 'Ваш аккаунт ограничен.', buttons: [{ text: 'Это ошибка', data: 'x' }] },
    { message: 'Спасибо! Ваша жалоба принята и будет рассмотрена.' },
  ])
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'appealed')
  assert.equal(r.appealed, true)
})

test('бот просит описать проблему словами → шлём текст → appealed', async () => {
  const c = fakeClient([
    { message: 'Please describe what happened in a few words.' },
    { message: 'Thank you, your message has been received.' },
  ])
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'appealed')
  assert.equal(r.appealed, true)
})

test('ограничен, оспорить нечем (нет кнопки, не просит текст) → blocked', async () => {
  const c = fakeClient([{ message: 'Your account is limited until 2026-08-01. You will be able to write later.' }])
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'blocked')
  assert.equal(r.appealed, false)
})

test('сбой сети/бота не роняет — возвращает unknown', async () => {
  const bad = { getEntity: async () => { throw new Error('offline') } }
  const r = await appealSpamblock(bad, opts)
  assert.equal(r.state, 'unknown')
})
