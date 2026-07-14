import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { channelKey } from '../channels.js'

test('channelKey: username приоритетнее, регистр/@ нормализуются', () => {
  assert.equal(channelKey({ username: '@Durov' }), 'u:durov')
  assert.equal(channelKey({ username: 'durov' }), 'u:durov')
  assert.equal(channelKey({ tgPeerId: '123' }), 'p:123')
  assert.equal(channelKey({ link: 'https://t.me/x/' }), 'l:https://t.me/x')
  assert.equal(channelKey({}), null)
})

test('upsert: дедуп по username, обновляет и добавляет источник (§4)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-'))
  process.env.CHANNELS_FILE = path.join(dir, 'channels.json')
  const C = await import('../channels.js?crud=' + Date.now())

  const a = await C.upsertChannel({ username: '@news', title: 'News', subscribers: 1000 }, 'run1')
  assert.equal((await C.listChannels()).length, 1)

  // повторный парсинг того же канала — НЕ дубль, а обновление + новый источник
  const b = await C.upsertChannel({ username: 'news', subscribers: 1500 }, 'run2')
  assert.equal(b.id, a.id) // тот же канал
  assert.equal((await C.listChannels()).length, 1)
  assert.equal(b.subscribers, 1500) // обновилось
  assert.equal(b.title, 'News') // пустое не затёрло старое
  assert.deepEqual([...b.sources].sort(), ['run1', 'run2'])

  const s = await C.recordChannelStats(a.id, { subscribers: 2000 }, 'acc1')
  assert.equal(s.subscribers, 2000)
  assert.equal(s.statsBy, 'acc1')
  assert.ok(s.lastStatsAt > 0)

  // upsertMany (парсер): дедуп в общей базе, обновление существующего одним батчем
  const n = await C.upsertMany([
    { username: 'news', subscribers: 3000 }, // существующий → обновить
    { username: 'newone', subscribers: 500 }, // новый
  ], 'parse:t1')
  assert.equal(n, 2)
  const list = await C.listChannels()
  assert.equal(list.length, 2) // без дубля (news уже был)
  assert.equal(list.find((c) => c.username === 'news').subscribers, 3000)

  delete process.env.CHANNELS_FILE
})
