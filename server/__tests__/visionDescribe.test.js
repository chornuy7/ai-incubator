/**
 * §10.5: анализ входящих изображений в нейродиалогах.
 *
 * Проверяем инвариант «vision не роняет диалог»: любая осечка (нет фото, не скачалось,
 * OpenAI ответил ошибкой) → null, а не исключение. И что при успехе возвращается
 * описание с расходом токенов — иначе биллинг картинки нечем считать.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageHasPhoto, describeIncomingImage } from '../lib/visionDescribe.js'

test('§10.5: messageHasPhoto распознаёт фото и картинку-документ', () => {
  assert.equal(messageHasPhoto({ media: { className: 'MessageMediaPhoto' } }), true)
  assert.equal(messageHasPhoto({ media: { document: { mimeType: 'image/png' } } }), true)
  assert.equal(messageHasPhoto({ media: { className: 'MessageMediaDocument', document: { mimeType: 'application/pdf' } } }), false)
  assert.equal(messageHasPhoto({ message: 'просто текст' }), false)
  assert.equal(messageHasPhoto(null), false)
})

test('§10.5: без ключа OpenAI vision не вызывается — тихо null', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const client = { downloadMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }
  const r = await describeIncomingImage(client, { media: { className: 'MessageMediaPhoto' } })
  assert.equal(r, null)
  if (savedKey) process.env.OPENAI_API_KEY = savedKey
})

test('§10.5: не скачалось / нет фото → null, без исключения', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test'
  // нет фото
  assert.equal(await describeIncomingImage({ downloadMedia: async () => Buffer.from([1]) }, { message: 'txt' }), null)
  // downloadMedia бросил
  const throwing = { downloadMedia: async () => { throw new Error('network') } }
  assert.equal(await describeIncomingImage(throwing, { media: { className: 'MessageMediaPhoto' } }), null)
  // пустой буфер
  const empty = { downloadMedia: async () => Buffer.alloc(0) }
  assert.equal(await describeIncomingImage(empty, { media: { className: 'MessageMediaPhoto' } }), null)
  if (savedKey) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY
})

test('§10.5: успех — описание + расход токенов для биллинга', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'sk-test'
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'Кот на диване.' } }],
      usage: { total_tokens: 300, prompt_tokens: 250, completion_tokens: 50 },
    }),
  })
  const client = { downloadMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) }
  const r = await describeIncomingImage(client, { media: { className: 'MessageMediaPhoto' } })
  assert.ok(r, 'должно вернуть результат')
  assert.equal(r.text, 'Кот на диване.')
  assert.equal(r.usage.tokens, 300, 'токены нужны биллингу картинки')
  globalThis.fetch = savedFetch
  if (savedKey) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY
})

test('§10.5: OpenAI ответил ошибкой → null (диалог продолжается по тексту)', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'sk-test'
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate' })
  const client = { downloadMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]) }
  assert.equal(await describeIncomingImage(client, { media: { className: 'MessageMediaPhoto' } }), null)
  globalThis.fetch = savedFetch
  if (savedKey) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY
})
