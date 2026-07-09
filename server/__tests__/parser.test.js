import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSubscribers, extractPeerMeta, looksLikeCloudflare } from '../tgstat/parser.js'

test('parseSubscribers: разные форматы чисел', () => {
  assert.equal(parseSubscribers('1.2K'), 1200)
  assert.equal(parseSubscribers('12К участников'), 12000)
  assert.equal(parseSubscribers('33 550 participants'), 33550)
  assert.equal(parseSubscribers('2.1M'), 2100000)
  assert.equal(parseSubscribers(''), 0)
  assert.equal(parseSubscribers('нет чисел'), 0)
})

test('extractPeerMeta: канал/чат → t.me + username', () => {
  const a = extractPeerMeta('https://uk.tgstat.com/channel/@durov', 'https://uk.tgstat.com')
  assert.equal(a.username, 'durov')
  assert.equal(a.chatLink, 'https://t.me/durov')

  const b = extractPeerMeta('/ru/chat/somechat', 'https://tgstat.com/ru')
  assert.equal(b.username, 'somechat')

  assert.equal(extractPeerMeta('https://tgstat.com/ratings', 'https://tgstat.com'), null)
})

test('looksLikeCloudflare: детект challenge', () => {
  assert.equal(looksLikeCloudflare('<html>cloudflare checking your browser</html>'), true)
  assert.equal(looksLikeCloudflare('<div class="peer-item">ok</div>'), false)
})
