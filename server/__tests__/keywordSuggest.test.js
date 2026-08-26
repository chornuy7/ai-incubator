/**
 * Подсказка ключевых слов (просьба владельца 26.08: «можно сделать, чтобы предложка
 * реально работала?»).
 *
 * Главное, что тут закрывается, — то, из-за чего старый блок был бесполезен: он не
 * зависел от введённых слов. Поэтому проверяем, что каждый вариант выводится из
 * конкретного слова списка, и что мы не порождаем мусор вроде «ищу нужен разработчик».
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intentVariants, langOfWord, aiVariants } from '../keywordSuggest.js'

test('язык определяется по одному слову, украинский не путается с русским', () => {
  assert.equal(langOfWord('массаж'), 'ru')
  assert.equal(langOfWord('програмування'), 'uk')
  assert.equal(langOfWord('marketing'), 'en')
  assert.equal(langOfWord('123'), null)
})

test('шаблоны намерения строятся от введённых слов, а не из зашитого списка', () => {
  const out = intentVariants(['массаж', 'marketing'])
  assert.ok(out.length > 0)
  for (const it of out) {
    assert.ok(['массаж', 'marketing'].includes(it.from), `вариант «${it.w}» ни от какого слова`)
    assert.ok(it.w.includes(it.from), `вариант «${it.w}» не содержит исходное слово`)
    assert.equal(it.src, 'intent')
  }
  // Язык шаблона совпадает с языком слова: «looking for массаж» — не то, что ищут.
  assert.ok(out.some((i) => i.w === 'ищу массаж'))
  assert.ok(out.some((i) => i.w === 'looking for marketing'))
  assert.ok(!out.some((i) => i.from === 'массаж' && /looking|need|hire/.test(i.w)))
})

test('слово, которое уже само намерение, второй раз не обвешивается', () => {
  assert.deepEqual(intentVariants(['нужен разработчик']), [])
  assert.deepEqual(intentVariants(['looking for developer']), [])
})

test('то, что уже есть в списке, повторно не предлагается', () => {
  const out = intentVariants(['массаж', 'ищу массаж'])
  assert.ok(!out.some((i) => i.w === 'ищу массаж'))
})

test('без ключа OpenAI подсказка честно говорит, что ИИ выключен, а не молчит', async () => {
  const saved = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const r = await aiVariants(['массаж'])
    assert.equal(r.mode, 'off')
    assert.deepEqual(r.items, [])
    assert.match(r.reason, /Ключ OpenAI/)
  } finally { if (saved) process.env.OPENAI_API_KEY = saved }
})

test('пустой список — не повод идти в сеть', async () => {
  const r = await aiVariants([])
  assert.equal(r.mode, 'off')
})

test('ответ модели чистится: исходные слова и дубли выбрасываются', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ items: [
        { from: 'массаж', w: 'массажист', kind: 'synonym' },
        { from: 'массаж', w: 'Массаж', kind: 'synonym' },   // это исходное слово, только с большой буквы
        { from: 'массаж', w: 'массажист', kind: 'synonym' }, // дубль
        { from: 'массаж', w: 'massage', kind: 'translation' },
      ] }) } }],
      usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12 },
      model: 'gpt-4o-mini',
    }),
  })
  try {
    const r = await aiVariants(['массаж'])
    assert.equal(r.mode, 'openai')
    assert.deepEqual(r.items.map((i) => i.w), ['массажист', 'massage'])
    assert.equal(r.items[1].why, 'перевод')
    assert.equal(r.usage.tokens, 42) // расход уходит в журнал токенов
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY
  }
})

test('сбой OpenAI не роняет подсказку — возвращается причина', async () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limit' })
  try {
    const r = await aiVariants(['массаж'])
    assert.equal(r.mode, 'error')
    assert.match(r.reason, /429/)
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY
  }
})

test('бессмысленные связки не предлагаются: «hire bitcoin», «ищу создать бота»', () => {
  const out = intentVariants(['bitcoin', 'создать бота'])
  assert.ok(!out.some((i) => i.w.startsWith('hire ')), 'нанимать биткоин нельзя')
  assert.ok(!out.some((i) => i.from === 'создать бота'), 'слово уже само запрос — обвешивать не надо')
})
