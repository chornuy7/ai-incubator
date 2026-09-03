/**
 * Проверка спамблока: вердикт по ответу @SpamBot и запись в журнал действий.
 *
 * Созвон 19.08: «в истории аккаунта НЕТ проверки спамблока — добавить». Живьём эта
 * ветка достижима только реальным коннектом к Telegram и реально ограниченным
 * аккаунтом, поэтому руками проверяется в лучшем случае один случай из четырёх.
 * Здесь закрываем все: чистый, ограниченный, невнятный ответ и обрыв связи.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// Ответ бота разбираем сразу — боевую паузу в 2.5с здесь ждать нечего.
process.env.SPAMCHECK_WAIT_MS = '1'
const { checkSpamblock, spamcheckAction } = await import('../accountStats.js')

/**
 * Клиент-заглушка: отдаёт текст и опционально кнопки «от @SpamBot» либо падает.
 * buttons — массив строк (текст кнопок), они идут в одну строку ReplyKeyboardMarkup.
 */
const fakeClient = (message, { fail = false, buttons = null } = {}) => ({
  getEntity: async () => { if (fail) throw new Error('network'); return { id: 1 } },
  sendMessage: async () => {},
  getMessages: async () => {
    const msg = { message }
    if (buttons) msg.replyMarkup = { rows: [{ buttons: buttons.map((text) => ({ text })) }] }
    return [msg]
  },
})

test('чистый аккаунт: ответ бота читается как «ограничений нет»', async () => {
  for (const text of [
    'Good news, no limits are currently applied to your account.',
    'You are free as a bird!',
    'Ограничения сняты, аккаунт свободен.',
  ]) {
    const r = await checkSpamblock(fakeClient(text))
    assert.equal(r.state, 'clean', text)
    assert.equal(r.text, text)
  }
})

test('ограниченный аккаунт: ответ бота читается как спамблок', async () => {
  for (const text of [
    'I’m afraid your account is limited until 12.09.2026.',
    'Your account was restricted by moderators.',
    'Аккаунт ограничен до 12.09.2026.',
  ]) {
    const r = await checkSpamblock(fakeClient(text))
    assert.equal(r.state, 'blocked', text)
  }
})

test('невнятный ответ — «неизвестно», а не «чисто»', async () => {
  const r = await checkSpamblock(fakeClient('Choose an option below:'))
  assert.equal(r.state, 'unknown', 'молчание/меню бота нельзя считать подтверждением, что аккаунт чист')
})

test('оборвалась связь — «неизвестно» и пустой текст, без падения', async () => {
  const r = await checkSpamblock(fakeClient('', { fail: true }))
  assert.deepEqual(r, { state: 'unknown', text: '' })
})

test('португальский: кнопка апелляции → «ограничен», а не «неизвестно»', async () => {
  // Живой кейс 02.09: «Olá, Abel! …alguns números de telefone…» дал state:'unknown'.
  // Теперь кнопка апелляции (не-нейтральная) → blocked, независимо от языка текста.
  const r = await checkSpamblock(fakeClient('Olá, Abel! Algumas restrições foram aplicadas à sua conta.', { buttons: ['OK', 'Este é um engano'] }))
  assert.equal(r.state, 'blocked', 'нейтивный текст на португальском не должен давать «неизвестно»')
})

test('португальский: только «OK» → «чисто», а не «неизвестно»', async () => {
  const r = await checkSpamblock(fakeClient('Olá! Nenhuma restrição aplicada à sua conta no momento.', { buttons: ['OK'] }))
  assert.equal(r.state, 'clean', 'только нейтральные кнопки при неизвестном тексте → clean')
})

test('длинный ответ бота обрезается — в журнал не уедет простыня', async () => {
  const r = await checkSpamblock(fakeClient('ограничен '.repeat(200)))
  assert.equal(r.text.length, 300)
})

test('запись в журнал: под-тип, цель и человекочитаемый итог', () => {
  const a = spamcheckAction('acc_1', 'Ілля', { state: 'clean', text: 'no limits' })
  assert.equal(a.type, 'action')
  assert.equal(a.value.kind, 'spamcheck', 'по этому под-типу лента и фильтр находят проверку')
  assert.equal(a.target, '@SpamBot')
  assert.equal(a.initiator, 'operator', 'проверку запускает человек, задачи за ней нет')
  assert.equal(a.accountId, 'acc_1')
  assert.equal(a.accountName, 'Ілля')
  assert.match(a.value.text, /Спамблока нет/)
  assert.equal(a.meta.spamblock, 'clean')
  assert.equal(a.meta.spamblockText, 'no limits')
})

test('молчание бота — неудачная проверка, а не «аккаунт чист»', () => {
  assert.equal(spamcheckAction('a', '', { state: 'unknown' }).status, 'failed')
  assert.equal(spamcheckAction('a', '', { state: 'clean' }).status, 'sent')
  assert.equal(spamcheckAction('a', '', { state: 'blocked' }).status, 'sent')
})

test('у каждого вердикта своя формулировка — в ленте видно РЕЗУЛЬТАТ, а не «Действие»', () => {
  const texts = ['clean', 'blocked', 'unknown'].map((state) => spamcheckAction('a', '', { state }).value.text)
  assert.equal(new Set(texts).size, 3, 'три состояния — три разных фразы')
  for (const t of texts) assert.ok(t && t.length > 10, t)
})
