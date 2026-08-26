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
      if (s.buttons) msg.replyMarkup = { rows: [{ buttons: s.buttons.map((b) => (b.data ? { text: b.text, data: Buffer.from(b.data) } : { text: b.text })) }] }
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

/**
 * Живая проверка 22.08: @SpamBot шлёт ReplyKeyboardMarkup — кнопки БЕЗ `data`
 * («OK», «What is spam?», «I was wrong, please release me», «This is a mistake»).
 * Прежний отбор брал только кнопки с `data` и не находил ни одной: модуль писал
 * «ограничение осталось», ни разу не пожаловавшись. Такую кнопку жмут отправкой текста.
 */
test('обычная клавиатура @SpamBot: жалоба всё-таки подаётся', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'Your account is now limited.', buttons: [
      { text: 'OK' }, { text: 'What is spam?' },
      { text: 'I was wrong, please release me' }, { text: 'This is a mistake' },
    ] },
    { message: 'Thank you, your complaint has been received.' },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.equal(r.appealed, true, 'жалоба не подана')
  assert.equal(r.state, 'appealed')
  assert.ok(нажато.includes('This is a mistake'), `нажали не то: ${JSON.stringify(нажато)}`)
})

test('«OK» и «What is spam?» не жмём — это не апелляция', async () => {
  const нажато = []
  const c = fakeClient([{ message: 'While the account is limited, you will not be able to send messages.', buttons: [{ text: 'OK' }, { text: 'What is spam?' }] }])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.equal(r.appealed, false)
  assert.equal(r.state, 'blocked')
  assert.deepEqual(нажато, ['/start'], `нажали лишнее: ${JSON.stringify(нажато)}`)
})

/**
 * Второй шаг живого диалога (22.08): нажали «This is a mistake» → бот переспрашивает
 * «Would you like to submit a complaint?» с Yes/No. Без ответа жалоба НЕ подана, а
 * модуль в этом месте рапортовал «жалоба подана — ждём модерацию».
 */
test('бот переспрашивает — отвечаем Yes и доводим жалобу до подтверждения', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'While the account is limited…', buttons: [{ text: 'OK' }, { text: 'This is a mistake' }] },
    { message: 'Would you like to submit a complaint?', buttons: [{ text: 'Yes' }, { text: 'No' }] },
    { message: 'Your complaint has been submitted to moderators.' },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.deepEqual(нажато, ['/start', 'This is a mistake', 'Yes'])
  assert.equal(r.state, 'appealed', 'жалоба должна быть доведена до подтверждения')
})

test('«Да» жмём только на вопрос про жалобу, а не на любой вопрос бота', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'While the account is limited…', buttons: [{ text: 'This is a mistake' }] },
    { message: 'Do you understand why this happened?', buttons: [{ text: 'Yes' }, { text: 'No' }] },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.deepEqual(нажато, ['/start', 'This is a mistake'], 'соглашаться вслепую нельзя')
  // Нажали, но подтверждения нет — честный «не довели», а не «жалоба подана».
  assert.equal(r.state, 'stalled')
})

/**
 * Третий шаг живого диалога (22.08): бот переспрашивает «Did you ever do any of this?»
 * с вариантами «No! Never did that!» / «Well… In fact I did.». На трёх шагах цикл
 * обрывался здесь и жалоба до модераторов не доходила.
 */
test('диалог из четырёх шагов доводится до приёма жалобы', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'While the account is limited…', buttons: [{ text: 'OK' }, { text: 'This is a mistake' }] },
    { message: 'Would you like to submit a complaint?', buttons: [{ text: 'Yes' }, { text: 'No' }] },
    { message: 'Please confirm that you have never sent this to strangers. Did you ever do any of this?', buttons: [{ text: 'No! Never did that!' }, { text: 'Well… In fact I did.' }] },
    { message: 'Thank you, your complaint has been submitted.' },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.deepEqual(нажато, ['/start', 'This is a mistake', 'Yes', 'No! Never did that!'])
  assert.equal(r.state, 'appealed')
})

/**
 * Последний шаг апелляции — анти-бот проверка Telegram. Проходить её автоматически
 * нельзя; модуль обязан довести жалобу до этого места и честно передать человеку,
 * а не рапортовать «жалоба подана» и не пытаться проверку обойти.
 */
test('капча в конце: доводим до неё и честно отдаём человеку', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'While the account is limited…', buttons: [{ text: 'This is a mistake' }] },
    { message: 'Would you like to submit a complaint?', buttons: [{ text: 'Yes' }, { text: 'No' }] },
    { message: 'Did you ever do any of this?', buttons: [{ text: 'No! Never did that!' }, { text: 'Well… In fact I did.' }] },
    { message: 'Please verify you are a human.' },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'captcha')
  assert.equal(r.appealed, true, 'жалоба заполнена — просто не подтверждена человеком')
  assert.deepEqual(нажато, ['/start', 'This is a mistake', 'Yes', 'No! Never did that!'])
})

/**
 * Та же капча, но КНОПКОЙ, а не текстом сообщения. Прежде такой шаг проваливался в
 * 'stalled' («диалог не завершён»): regex по тексту кнопку не видел, а appealButton про
 * капчу не знает. Кнопку «я не робот» жать нельзя — доводим до неё и отдаём человеку.
 */
test('капча кнопкой «я не робот»: не жмём её, отдаём человеку как captcha', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'While the account is limited…', buttons: [{ text: 'This is a mistake' }] },
    { message: 'Would you like to submit a complaint?', buttons: [{ text: 'Yes' }, { text: 'No' }] },
    { message: 'One last step to submit your complaint:', buttons: [{ text: "I'm not a robot" }] },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'captcha', 'кнопочную капчу обязаны распознать')
  assert.ok(!нажато.includes("I'm not a robot"), `кнопку «я не робот» жать нельзя: ${JSON.stringify(нажато)}`)
  assert.deepEqual(нажато, ['/start', 'This is a mistake', 'Yes'])
})

test('капча кнопкой на русском («Пройти проверку») — тоже captcha, не жмём', async () => {
  const нажато = []
  const c = fakeClient([
    { message: 'Аккаунт ограничен.', buttons: [{ text: 'Это ошибка' }] },
    { message: 'Остался последний шаг:', buttons: [{ text: 'Пройти проверку' }] },
  ])
  const send = c.sendMessage
  c.sendMessage = async (peer, args) => { нажато.push(args.message); return send(peer, args) }
  const r = await appealSpamblock(c, opts)
  assert.equal(r.state, 'captcha')
  assert.ok(!нажато.includes('Пройти проверку'), `проверку жать нельзя: ${JSON.stringify(нажато)}`)
})
