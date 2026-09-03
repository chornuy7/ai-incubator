import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTelegramPostLink, parseTelegramPostLinks } from '../lib/postLink.js'

test('parseTelegramPostLink: публичный пост', () => {
  const r = parseTelegramPostLink('https://t.me/durov/123')
  assert.deepEqual(r, { kind: 'public', username: 'durov', msgId: 123, label: 'https://t.me/durov/123' })
  // без протокола
  assert.equal(parseTelegramPostLink('t.me/channel_x/7').kind, 'public')
})

test('parseTelegramPostLink: приватный /c/ пост', () => {
  const r = parseTelegramPostLink('https://t.me/c/1234567890/55')
  assert.equal(r.kind, 'private')
  assert.equal(r.chatId, '-1001234567890')
  assert.equal(r.msgId, 55)
})

test('parseTelegramPostLink: служебные и мусор → null', () => {
  assert.equal(parseTelegramPostLink('https://t.me/joinchat/AAAA'), null)
  assert.equal(parseTelegramPostLink('https://t.me/share/url'), null)
  assert.equal(parseTelegramPostLink('t.me/onlyusername'), null) // нет msgId
  assert.equal(parseTelegramPostLink(''), null)
  assert.equal(parseTelegramPostLink('   '), null)
})

test('parseTelegramPostLinks: фильтрует невалидные', () => {
  const out = parseTelegramPostLinks(['https://t.me/a/1', 'мусор', 't.me/b/2', ''])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((x) => x.username), ['a', 'b'])
  assert.deepEqual(parseTelegramPostLinks(undefined), [])
})
