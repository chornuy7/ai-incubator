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

test('proxyUsageMap / sharedProxies: считают по ССЫЛКЕ, а не по строке подключения', async () => {
  /*
   * MR-290. Раньше ключом была собранная строка `socks5://user:pass@host:port`, и счёт
   * был неверным по построению: смена пароля превращала один прокси в два разных ключа,
   * а потеря строки — в ноль занятых. На боевой случилось второе: строка подключения
   * обнулилась у всех аккаунтов, «занят N» показывал ноль при 55 назначенных прокси.
   */
  const { proxyUsageMap, sharedProxies } = await import('../proxies.js')
  const meta = {
    a1: { proxyId: 'px_one' },
    a2: { proxyId: 'px_one' }, // тот же прокси → shared
    a3: { proxyId: 'px_two' },
    a4: { proxy: 'socks5://1.1.1.1:1080' }, // строка без ссылки больше не считается
    a5: {},
  }
  const usage = proxyUsageMap(meta)
  assert.deepEqual(usage.px_one.sort(), ['a1', 'a2'])
  assert.equal(usage.px_two.length, 1)
  assert.equal(usage['socks5://1.1.1.1:1080'], undefined, 'строка подключения ключом больше не бывает')
  const shared = sharedProxies(meta)
  assert.equal(shared.length, 1)
  assert.equal(shared[0].proxyId, 'px_one')
  assert.deepEqual(shared[0].accountIds.sort(), ['a1', 'a2'])
})

test('tcpPing: живой порт → true, закрытый → false', async () => {
  const net = await import('node:net')
  const { tcpPing } = await import('../proxies.js')
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  assert.equal(await tcpPing('127.0.0.1', port, 2000), true)
  await new Promise((r) => server.close(r))
  assert.equal(await tcpPing('127.0.0.1', port, 1500), false) // порт закрыт
  assert.equal(await tcpPing('', 0), false)
})
