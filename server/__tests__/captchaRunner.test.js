import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractButtons, normalizeMessage, looksLikeCaptcha, planFromMessages, resolveGroupCaptcha } from '../lib/captchaRunner.js'

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

// ── resolveGroupCaptcha: live-ветки на mock-клиенте ──

function mockClient({ messages }) {
  const calls = { clicks: [], sent: [], invoked: [] }
  const client = {
    getMessages: async () => messages,
    sendMessage: async (_peer, opts) => { calls.sent.push(opts.message) },
    invoke: async (req) => { calls.invoked.push(req?.className || 'req') },
    getMe: async () => ({ id: 1 }),
  }
  return { client, calls }
}

test('resolveGroupCaptcha: math → auto клик по кнопке', async () => {
  const msg = {
    message: 'Реши: 5 + 6 = ?',
    sender: { username: 'shieldy_bot' },
    replyMarkup: { rows: [{ buttons: [{ text: '10' }, { text: '11' }] }] },
    click: async function (opts) { this._clicked = opts.text },
  }
  const { client } = mockClient({ messages: [msg] })
  const res = await resolveGroupCaptcha(client, { id: 1 })
  assert.equal(res.handled, true)
  assert.equal(res.action, 'auto')
  assert.equal(msg._clicked, '11') // кликнули верный ответ
})

test('resolveGroupCaptcha: reCAPTCHA → operator, действий нет', async () => {
  const msg = { message: 'Введите код из СМС', sender: { username: 'safeguard' }, buttons: [] }
  const { client, calls } = mockClient({ messages: [msg] })
  const res = await resolveGroupCaptcha(client, { id: 1 })
  assert.equal(res.handled, false)
  assert.equal(res.action, 'operator')
  assert.equal(calls.sent.length, 0)
})

test('resolveGroupCaptcha: нераспознанная капча ОТ КАПЧА-БОТА → skip (выход)', async () => {
  // известный бот + нераспознаваемый вызов → classify none/skip → выходим (высокая уверенность)
  const msg = { message: 'пройди проверку по нашей ссылке', sender: { username: 'shieldy_bot' }, buttons: [] }
  const { client, calls } = mockClient({ messages: [msg] })
  const res = await resolveGroupCaptcha(client, { id: 1 })
  assert.equal(res.action, 'skip')
  assert.equal(res.handled, true)
  assert.ok(calls.invoked.length >= 1) // LeaveChannel вызван
})

test('resolveGroupCaptcha: keyword-ложное срабатывание (не бот) → остаёмся, НЕ выходим', async () => {
  // «проверка» в обычном посте канала → looksLikeCaptcha по слову, но не капча-бот → не трогаем
  const msg = { message: 'проверка связи, всем привет', sender: { username: 'somechannel' }, buttons: [] }
  const { client, calls } = mockClient({ messages: [msg] })
  const res = await resolveGroupCaptcha(client, { id: 1 })
  assert.equal(res.action, 'skip')
  assert.equal(res.handled, false) // остаёмся в канале
  assert.equal(calls.invoked.length, 0) // LeaveChannel НЕ вызван
})

test('resolveGroupCaptcha: нет капчи → handled=false, ничего не делаем', async () => {
  const { client, calls } = mockClient({ messages: [{ message: 'привет', sender: { username: 'ivan' } }] })
  const res = await resolveGroupCaptcha(client, { id: 1 })
  assert.equal(res.handled, false)
  assert.equal(calls.sent.length + calls.invoked.length, 0)
})
