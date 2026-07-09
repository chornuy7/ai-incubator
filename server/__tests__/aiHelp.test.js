import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerHelp } from '../aiHelp.js'

// Без OPENAI_API_KEY answerHelp работает по fallback-фактам (mode: template_no_key).
const noKey = !process.env.OPENAI_API_KEY?.trim()

test('answerHelp: пустой вопрос', async () => {
  const r = await answerHelp({ topic: 'Тест', question: '  ' })
  assert.match(r.answer, /вопрос/i)
})

test('answerHelp: fallback про задержки', { skip: !noKey }, async () => {
  const r = await answerHelp({ topic: 'Нейрокомментинг', question: 'как настроить задержки?' })
  assert.equal(r.mode, 'template_no_key')
  assert.match(r.answer, /задержк/i)
})

test('answerHelp: fallback про занятые аккаунты', { skip: !noKey }, async () => {
  const r = await answerHelp({ topic: 'Парсер', question: 'почему аккаунт занят?' })
  assert.match(r.answer, /лок|задач/i)
})
