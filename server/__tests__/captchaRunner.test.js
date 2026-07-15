import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractButtons, normalizeMessage, looksLikeCaptcha, planFromMessages } from '../lib/captchaRunner.js'

test('extractButtons: собирает текст из строк reply_markup', () => {
  const msg = { replyMarkup: { rows: [{ buttons: [{ text: '11' }, { text: '12' }] }, { buttons: [{ text: '13' }] }] } }
  assert.deepEqual(extractButtons(msg).map((b) => b.text), ['11', '12', '13'])
  assert.deepEqual(extractButtons({}), [])
})

test('normalizeMessage: текст/кнопки/бот', () => {
  const n = normalizeMessage({ message: '  5 + 6 = ?  ', sender: { username: 'Shieldy_bot' }, replyMarkup: { rows: [{ buttons: [{ text: '11' }] }] } })
  assert.equal(n.text, '5 + 6 = ?')
  assert.equal(n.fromBot, 'shieldy_bot')
  assert.deepEqual(n.buttons.map((b) => b.text), ['11'])
})

test('looksLikeCaptcha: известный бот или ключевые слова', () => {
  assert.equal(looksLikeCaptcha({ text: 'привет всем', fromBot: 'shieldy' }), true) // бот
  assert.equal(looksLikeCaptcha({ text: 'нажмите кнопку чтобы подтвердить', buttons: [{ text: 'Я не бот' }] }), true)
  assert.equal(looksLikeCaptcha({ text: 'обычное сообщение', fromBot: 'ivan' }), false)
})

test('planFromMessages: выбирает математическую капчу → auto', () => {
  const messages = [
    { text: 'добро пожаловать', fromBot: 'admin', buttons: [] },
    { text: 'Реши пример: 5 + 6 = ?', fromBot: 'shieldy', buttons: [{ text: '10' }, { text: '11' }] },
  ]
  const res = planFromMessages(messages)
  assert.ok(res)
  assert.equal(res.plan.action, 'auto')
  assert.equal(res.plan.type, 'math')
  assert.deepEqual(res.plan.solution, { button: '11' })
})

test('planFromMessages: reCAPTCHA/SMS → operator (ToS)', () => {
  const res = planFromMessages([{ text: 'Введите код из СМС для проверки', fromBot: 'safeguard', buttons: [] }])
  assert.ok(res)
  assert.equal(res.plan.action, 'operator')
})

test('planFromMessages: нет капчи → null', () => {
  assert.equal(planFromMessages([{ text: 'просто чат', fromBot: 'vasya', buttons: [] }]), null)
})
