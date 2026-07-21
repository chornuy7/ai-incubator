import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyByRules, shouldAdvance, classifyLeadReply } from '../lib/leadClassifier.js'

// NB: тесты гоняют правила (без OPENAI_API_KEY в окружении теста) — это же фолбэк в проде.

test('classifyByRules: отказ → closed (важнее всего — перестать писать)', () => {
  for (const t of ['Отстань, не пиши мне', 'не интересно', 'спам, отпишись']) {
    assert.equal(classifyByRules(t).status, 'closed', t)
  }
})

test('classifyByRules: подтверждение действия словами → target', () => {
  for (const t of ['да я уже подписался', 'вступил, спасибо', 'готово']) {
    assert.equal(classifyByRules(t).status, 'target', t)
  }
})

test('classifyByRules: просит ссылку / готов → hot', () => {
  for (const t of ['скинь ссылку', 'как вступить?', 'хочу']) {
    assert.equal(classifyByRules(t).status, 'hot', t)
  }
})

test('classifyByRules: вопросы → interested, односложное → contacted', () => {
  assert.equal(classifyByRules('а что это такое? расскажи подробнее').status, 'interested')
  assert.equal(classifyByRules('сколько стоит').status, 'interested')
  assert.equal(classifyByRules('ок').status, 'contacted')
  assert.equal(classifyByRules('ага').status, 'contacted')
})

test('classifyByRules: развёрнутый нейтральный ответ → warm; пусто → null', () => {
  assert.equal(classifyByRules('ну в целом норм тема, работаю с криптой').status, 'warm')
  assert.equal(classifyByRules(''), null)
})

test('кириллица матчится (регресс: \\b в JS не работает с не-ASCII)', () => {
  // Раньше все ответы падали в warm, потому что \b не срабатывал на кириллице.
  assert.notEqual(classifyByRules('отстань').status, 'warm')
  assert.notEqual(classifyByRules('подписался').status, 'warm')
})

test('после отправки ссылки короткий отклик = выполнено (§9)', () => {
  // «Спасибо», «+», «ок» после ссылки — это подтверждение: человеку больше нечего
  // сказать, он её забрал. Раньше такие ответы застревали в contacted, и лид
  // навсегда оставался hot, хотя по факту дошёл до конца.
  for (const t of ['спасибо', '+', 'ок', 'ага']) {
    assert.equal(classifyByRules(t, 'hot').status, 'target', t)
  }
  // А до отправки ссылки то же самое ничего не подтверждает.
  assert.equal(classifyByRules('спасибо', 'warm').status, 'contacted')
  assert.equal(classifyByRules('ок', 'cold').status, 'contacted')
  // Отказ важнее всего и на любой стадии.
  assert.equal(classifyByRules('не интересно', 'hot').status, 'closed')
})

test('shouldAdvance: только вперёд, терминальные не откатываются', () => {
  assert.equal(shouldAdvance('cold', 'warm'), true)
  assert.equal(shouldAdvance('warm', 'cold'), false)      // назад нельзя
  assert.equal(shouldAdvance('warm', 'warm'), false)      // без изменений
  assert.equal(shouldAdvance('warm', 'closed'), true)     // отказ — в любой момент
  assert.equal(shouldAdvance('target', 'warm'), false)    // терминальный держим
  assert.equal(shouldAdvance('closed', 'hot'), false)
})

test('classifyLeadReply: без ключа OpenAI отдаёт вердикт правил (mode=rules)', async () => {
  const prev = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const r = await classifyLeadReply({ text: 'скинь ссылку', currentStatus: 'cold' })
    assert.equal(r.mode, 'rules')
    assert.equal(r.status, 'hot')
    // Пустой ответ не двигает воронку.
    const empty = await classifyLeadReply({ text: '   ', currentStatus: 'warm' })
    assert.equal(empty.status, 'warm')
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev
  }
})
