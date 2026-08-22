/**
 * Два бага прогона 21.07 (docs/QA-run-2026-07-21-results.md), оба 🔴:
 *  - мёртвый ключ OpenAI молча деградировал в шаблон и лил отписки в реальные каналы;
 *  - шаблон выбирался по promptIndex, поэтому все аккаунты писали одно и то же слово в слово.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOpenAiError, generateComment, cleanCommentText } from '../neuroCommenting/commentGenerator.js'

test('classifyOpenAiError: кончились деньги — фатально, «слишком часто» — нет', () => {
  const quota = classifyOpenAiError(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')
  assert.equal(quota.fatal, true, 'insufficient_quota лечится только оплатой')

  const rate = classifyOpenAiError(429, '{"error":{"code":"rate_limit_exceeded"}}')
  assert.equal(rate.fatal, false, 'частота пройдёт сама — не повод валить задачу')

  assert.equal(classifyOpenAiError(401, '').fatal, true)
  assert.equal(classifyOpenAiError(403, '').fatal, true)
  assert.equal(classifyOpenAiError(404, '').fatal, true, 'нет доступа к модели — сам не починится')
  assert.equal(classifyOpenAiError(500, '').fatal, false, 'сбой на их стороне — временный')
  assert.equal(classifyOpenAiError(503, '').fatal, false)
})

test('фатальная ошибка не превращается в шаблон, а возвращает mode=fatal', async (t) => {
  const key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test-dead'
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'insufficient_quota' } }),
    { status: 429 },
  )
  t.after(() => {
    globalThis.fetch = realFetch
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
  })

  const r = await generateComment('Пост про рынок', 0, 'системный промпт')
  assert.equal(r.mode, 'fatal')
  assert.equal(r.text, null, 'текста быть не должно — публиковать нечего')
  assert.match(r.reason, /квота/i)
})

test('временная ошибка сети всё ещё даёт шаблон — это подстраховка на один коммент', async (t) => {
  const key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test'
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNRESET') }
  t.after(() => {
    globalThis.fetch = realFetch
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
  })

  const r = await generateComment('Разбор ситуации на рынке нефти сегодня', 0, '')
  assert.equal(r.mode, 'template_api_error')
  assert.ok(r.text && r.text.length > 3)
})

test('без ключа шаблоны РАЗНЫЕ у разных аккаунтов при одном promptIndex', async (t) => {
  const key = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key })

  // Ровно сценарий бага: 30 аккаунтов, один и тот же пост, один promptIndex —
  // но у каждого свой variantSeed (id аккаунта), как в реальном вызове.
  const seen = new Set()
  for (let i = 0; i < 30; i += 1) {
    const { text } = await generateComment('Welcome!', 0, '', `acc_${i}`)
    seen.add(text)
  }
  assert.ok(seen.size > 1, 'все аккаунты написали одинаковый текст — это сетка ботов в глазах Telegram')
})

test('avoid: уже отправленный текст не повторяется, пока есть свежие варианты', async (t) => {
  const key = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key })

  const used = []
  for (let i = 0; i < 5; i += 1) {
    const { text } = await generateComment('Welcome!', 0, '', { avoid: used })
    assert.ok(!used.includes(text), `повтор на шаге ${i}: «${text}»`)
    used.push(text)
  }
})

/**
 * Живой прогон 22.08: в канал ушло «Комментарий: Сообщение содержит лишь тестовый текст…».
 * Модель повторяет заголовок промпта, а по такому префиксу комментарий машинный за версту.
 */
test('служебный ярлык модели снимается, живой текст не трогаем', () => {
  assert.equal(cleanCommentText('Комментарий: Сообщение содержит лишь тестовый текст.'), 'Сообщение содержит лишь тестовый текст.')
  assert.equal(cleanCommentText('Comment: nice'), 'nice')
  assert.equal(cleanCommentText('Я: привет'), 'привет')
  // Кавычки вокруг всего ответа — тот же почерк.
  assert.equal(cleanCommentText('"Интересно, спасибо!"'), 'Интересно, спасибо!')
  // Ярлык и кавычки вперемешку — разбирается слоями, висячей кавычки не остаётся.
  assert.equal(cleanCommentText('Комментарий: "Ответ: вложенный"'), 'вложенный')
})

test('слово «комментарий» в живой фразе — не ярлык, режем только префикс с двоеточием', () => {
  assert.equal(cleanCommentText('Комментарии тут закрыты'), 'Комментарии тут закрыты')
  assert.equal(cleanCommentText('Ответ автору: спасибо'), 'Ответ автору: спасибо')
  assert.equal(cleanCommentText('Обычный текст без ярлыка'), 'Обычный текст без ярлыка')
})
