import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solveMath, matchButton, classifyCaptcha } from '../lib/captcha.js'

test('solveMath: +, -, *', () => {
  assert.equal(solveMath('5 + 7 = ?'), 12)
  assert.equal(solveMath('Реши: 9 - 4'), 5)
  assert.equal(solveMath('3 x 4'), 12)
  assert.equal(solveMath('6 × 2'), 12)
  assert.equal(solveMath('нет цифр'), null)
})

test('matchButton: находит кнопку по ответу', () => {
  const btns = [{ text: '10' }, { text: '12' }, { text: '14' }]
  assert.deepEqual(matchButton(btns, 12), { text: '12' })
  assert.equal(matchButton(btns, 99), null)
})

test('classifyCaptcha: Telegram-проверка → всегда operator (ToS)', () => {
  const r = classifyCaptcha({ text: 'Введите код из СМС для подтверждения' })
  assert.equal(r.type, 'telegram')
  assert.equal(r.action, 'operator')
  const r2 = classifyCaptcha({ text: 'Complete reCAPTCHA to continue' })
  assert.equal(r2.action, 'operator')
})

test('classifyCaptcha: математика → auto (кнопка или текст)', () => {
  const r = classifyCaptcha({ text: 'Сколько будет 5 + 7 = ?', buttons: [{ text: '11' }, { text: '12' }] })
  assert.equal(r.type, 'math')
  assert.equal(r.action, 'auto')
  assert.deepEqual(r.solution, { button: '12' })
  // без нужной кнопки — ответ текстом
  const r2 = classifyCaptcha({ text: 'реши: 2 + 2 = ?', buttons: [] })
  assert.deepEqual(r2.solution, { reply: '4' })
})

test('classifyCaptcha: кнопочная «я не бот» → auto', () => {
  const r = classifyCaptcha({ text: 'Нажмите кнопку ниже, чтобы подтвердить, что вы не бот', buttons: [{ text: 'Я не робот' }] })
  assert.equal(r.type, 'button')
  assert.equal(r.action, 'auto')
  assert.deepEqual(r.solution, { button: 'Я не робот' })
})

test('classifyCaptcha: игровая/картинка/кастом → operator', () => {
  assert.equal(classifyCaptcha({ text: 'Выбери животное среди эмодзи', buttons: [{ text: '🐱' }, { text: '🚗' }] }).action, 'operator')
  assert.equal(classifyCaptcha({ text: 'Введите символы с картинки', buttons: [] }).type, 'image')
  assert.equal(classifyCaptcha({ text: 'Вопрос: какого цвета небо?' }).type, 'custom')
})

test('classifyCaptcha: нет капчи → skip', () => {
  assert.equal(classifyCaptcha({ text: 'Добро пожаловать в чат!' }).action, 'skip')
})
