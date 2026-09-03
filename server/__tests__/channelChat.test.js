/**
 * Поиск чата канала (§3.9). Прогон 21.07: 132 цели из 148 дали `+1` — сам канал
 * вместо людей, потому что чат искали единственным способом (привязанная дискуссия).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findChannelChat, telegramLinks, looksLikeChatLink, isMegagroup } from '../lib/channelChat.js'

const chat = { className: 'Channel', megagroup: true, id: 'chat1' }
const channel = { className: 'Channel', megagroup: false, id: 'ch1' }

test('telegramLinks: вытаскивает t.me-ссылки и @имена, режет приглашения', () => {
  const text = 'Наш канал https://t.me/crypto_news и чат @crypto_chat, закрытый t.me/+AbCdEf'
  assert.deepEqual(telegramLinks(text), ['crypto_news', 'crypto_chat'])
})

test('telegramLinks: не считает ссылкой хвост другого урла', () => {
  assert.deepEqual(telegramLinks('пишите на mail@example.com'), [])
})

test('looksLikeChatLink: и по самому имени, и по слову рядом', () => {
  assert.equal(looksLikeChatLink('crypto_chat'), true)
  assert.equal(looksLikeChatLink('nash_obsuzhdenie'), true, 'обсужд — тоже чат')
  assert.equal(looksLikeChatLink('crypto_news'), false)
  // Имя нейтральное, но в тексте рядом стоит слово «чат».
  assert.equal(looksLikeChatLink('navigator_talk_room', 'Наш чат: @navigator_talk_room'), true)
})

test('isMegagroup: канал — не чат', () => {
  assert.equal(isMegagroup(chat), true)
  assert.equal(isMegagroup(channel), false)
  assert.equal(isMegagroup(null), false)
})

test('способ 1: привязанная дискуссия — берём её и дальше не лезем', async () => {
  let messagesCalled = 0
  const r = await findChannelChat(null, channel, {
    getFull: async () => ({ fullChat: { linkedChatId: 'chat1', about: '' } }),
    resolve: async (n) => (n === 'chat1' ? chat : null),
    getMessages: async () => { messagesCalled += 1; return [] },
  })
  assert.deepEqual(r, { peer: chat, via: 'discussion' })
  assert.equal(messagesCalled, 0, 'лишний getMessages — это FloodWait на ровном месте')
})

test('способ 2: ссылка на чат в описании канала', async () => {
  const r = await findChannelChat(null, channel, {
    getFull: async () => ({ fullChat: { linkedChatId: null, about: 'Новости рынка. Общение: @crypto_chat' } }),
    resolve: async (n) => (n === 'crypto_chat' ? chat : null),
    getMessages: async () => [],
  })
  assert.equal(r?.via, 'about')
})

test('способ 3: подпись «Channel | Chat» в последних постах', async () => {
  let limitAsked = 0
  const r = await findChannelChat(null, channel, {
    getFull: async () => ({ fullChat: { linkedChatId: null, about: 'Просто описание' } }),
    resolve: async (n) => (n === 'nav_chat' ? chat : null),
    getMessages: async (_p, opts) => {
      limitAsked = opts.limit
      return [{ message: 'Разбор рынка\n\nCrypto Navigator | Channel | Chat t.me/nav_chat' }]
    },
  })
  assert.equal(r?.via, 'posts')
  assert.equal(limitAsked, 3, 'глубже 2–3 постов не лезем — футер и так в каждом')
})

test('ссылка на ВТОРОЙ КАНАЛ не считается чатом', async () => {
  const r = await findChannelChat(null, channel, {
    getFull: async () => ({ fullChat: { linkedChatId: null, about: 'Наш второй чат @backup_chat' } }),
    // Резолвится, но это канал, а не мегагруппа.
    resolve: async () => channel,
    getMessages: async () => [],
  })
  assert.equal(r, null, 'канал вместо чата — это те самые «+1 участник» из прогона')
})

test('чата нет вообще — честный null, а не сам канал', async () => {
  const r = await findChannelChat(null, channel, {
    getFull: async () => ({ fullChat: { linkedChatId: null, about: '' } }),
    resolve: async () => null,
    getMessages: async () => [{ message: 'Обычный пост без ссылок' }],
  })
  assert.equal(r, null)
})

test('всё падает — не бросаем наружу, парсер должен идти дальше', async () => {
  const r = await findChannelChat(null, channel, {
    getFull: async () => { throw new Error('CHANNEL_PRIVATE') },
    resolve: async () => { throw new Error('USERNAME_NOT_OCCUPIED') },
    getMessages: async () => { throw new Error('FLOOD_WAIT_42') },
  })
  assert.equal(r, null)
})
