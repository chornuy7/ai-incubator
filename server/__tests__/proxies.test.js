import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeProxy, toProxyUrl } from '../proxies.js'

test('normalizeProxy: дефолты и типы', () => {
  const p = normalizeProxy({ label: '  UA  ', kind: 'farm', scheme: 'http', host: ' 1.2.3.4 ', port: '1080', country: 'UA', status: 'zzz' })
  assert.equal(p.label, 'UA')
  assert.equal(p.kind, 'farm')
  assert.equal(p.scheme, 'http')
  assert.equal(p.host, '1.2.3.4')
  assert.equal(p.port, 1080) // строка → число
  assert.equal(p.country, 'ua') // lower
  assert.equal(p.status, 'unknown') // мусор → unknown
  // мусорный kind → static
  assert.equal(normalizeProxy({ kind: 'zzz' }).kind, 'static')
})

test('toProxyUrl: сборка URL с авторизацией и без', () => {
  assert.equal(toProxyUrl({ scheme: 'socks5', host: '1.2.3.4', port: 1080 }), 'socks5://1.2.3.4:1080')
  assert.equal(toProxyUrl({ scheme: 'http', host: 'h', port: 8080, username: 'u', password: 'p' }), 'http://u:p@h:8080')
  assert.equal(toProxyUrl({ scheme: 'socks5', host: 'h', port: 1, username: 'u' }), 'socks5://u@h:1')
  assert.equal(toProxyUrl({ host: '', port: 0 }), '')
})

test('CRUD прокси на изолированном файле', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxies-'))
  process.env.PROXIES_FILE = path.join(dir, 'proxies.json')
  const m = await import('../proxies.js?crud=' + Date.now())

  assert.deepEqual(await m.listProxies(), [])
  const created = await m.createProxy({ host: '5.5.5.5', port: 1080, kind: 'mobile', country: 'pl' })
  assert.ok(created.id.startsWith('px_'))
  assert.equal(created.kind, 'mobile')
  assert.equal((await m.listProxies()).length, 1)

  const upd = await m.updateProxy(created.id, { status: 'ok', label: 'Мобайл PL' })
  assert.equal(upd.status, 'ok')
  assert.equal(upd.label, 'Мобайл PL')

  await assert.rejects(() => m.createProxy({ host: '', port: 0 }), /host и port/i)
  assert.equal(await m.updateProxy('нет', {}), null)
  assert.equal(await m.deleteProxy(created.id), true)
  assert.equal(await m.deleteProxy('нет'), false)
  assert.deepEqual(await m.listProxies(), [])

  delete process.env.PROXIES_FILE
})
