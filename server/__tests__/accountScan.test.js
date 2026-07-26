/**
 * Сканер проверяем на настоящем дереве папок: раскладываем tdata и .session так,
 * как их реально присылают продавцы, и смотрим, что найдено и что подтянуто из json.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { convertToTdata } from '@mtcute/convert'
import { nodeCryptoProvider } from '../lib/tdataCrypto.js'
import { scanFolder, listDirs, readSidecarJson } from '../lib/accountScan.js'
import { distributeProxies } from '../lib/accountImport.js'

const sessionData = () => ({
  version: 3,
  primaryDcs: {
    main: { id: 2, ipAddress: '149.154.167.41', port: 443 },
    media: { id: 2, ipAddress: '149.154.167.41', port: 443, mediaOnly: true },
  },
  authKey: new Uint8Array(crypto.randomBytes(256)),
  self: { userId: 777000, isBot: false, isPremium: false, usernames: [] },
})

/** Разложить типичную «пачку аккаунтов» от продавца. */
async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accscan-'))

  // 1. Папка аккаунта с вложенной tdata + json с телефоном и прокси.
  const a1 = path.join(root, '+79001112233')
  await fs.mkdir(path.join(a1, 'tdata'), { recursive: true })
  await convertToTdata(sessionData(), { path: path.join(a1, 'tdata'), crypto: nodeCryptoProvider() })
  await fs.writeFile(path.join(a1, 'info.json'), JSON.stringify({
    phone: '+7 900 111-22-33', twoFA: 'parol123', proxy: ['socks5', '1.2.3.4', 1080, 'u', 'p'],
  }), 'utf8')

  // 2. Ещё одна tdata, без json — телефон должен взяться из имени папки.
  const a2 = path.join(root, 'акк +380671234567')
  await fs.mkdir(a2, { recursive: true })
  await convertToTdata(sessionData(), { path: a2, crypto: nodeCryptoProvider() })

  // 3. Пачка .session в общей папке, у одного есть json-спутник.
  const files = path.join(root, 'sessions')
  await fs.mkdir(files, { recursive: true })
  await fs.writeFile(path.join(files, '+15550001111.session'), 'не важно — сканер не расшифровывает', 'utf8')
  await fs.writeFile(path.join(files, 'nickname.session'), 'тоже', 'utf8')
  await fs.writeFile(path.join(files, 'nickname.json'), JSON.stringify({ phone: '15559998888', proxy: 'socks5://5.6.7.8:1080' }), 'utf8')

  // 3b. Аккаунт, у которого облачный пароль лежит отдельным файлом, а не в json.
  const a3 = path.join(root, '+13148766744')
  await fs.mkdir(path.join(a3, 'tdata'), { recursive: true })
  await convertToTdata(sessionData(), { path: path.join(a3, 'tdata'), crypto: nodeCryptoProvider() })
  await fs.writeFile(path.join(a3, 'password.txt'), 'Ma2xQ\n', 'utf8')

  // 4. Мусор, который не должен попасть в результат.
  await fs.writeFile(path.join(root, 'readme.txt'), 'текст', 'utf8')
  await fs.mkdir(path.join(root, 'node_modules', 'что-то'), { recursive: true })

  return root
}

test('scanFolder: находит tdata и .session, мусор игнорирует', async () => {
  const root = await makeTree()
  const { items } = await scanFolder(root)

  const tdata = items.filter((i) => i.kind === 'tdata')
  const sess = items.filter((i) => i.kind === 'session-file')
  assert.equal(tdata.length, 3, 'три папки tdata')
  assert.equal(sess.length, 2, 'два файла .session')
  assert.ok(!items.some((i) => /readme/.test(i.name)), 'txt не аккаунт')
  assert.ok(!items.some((i) => i.path.includes('node_modules')), 'node_modules пропускается')

  await fs.rm(root, { recursive: true, force: true })
})

test('scanFolder: телефон и прокси подтягиваются из json рядом', async () => {
  const root = await makeTree()
  const { items } = await scanFolder(root)

  const withJson = items.find((i) => i.kind === 'tdata' && i.phone === '+79001112233')
  assert.ok(withJson, 'телефон разобран из json (пробелы и дефисы убраны)')
  assert.equal(withJson.proxy, 'socks5://u:p@1.2.3.4:1080', 'массив [type,host,port,user,pass] → URL')
  assert.equal(withJson.twoFA, 'parol123')

  const nick = items.find((i) => i.name === 'nickname')
  assert.equal(nick.proxy, 'socks5://5.6.7.8:1080', 'прокси строкой тоже понимается')

  await fs.rm(root, { recursive: true, force: true })
})

test('scanFolder: телефон достаётся из имени папки/файла, когда json нет', async () => {
  const root = await makeTree()
  const { items } = await scanFolder(root)

  assert.ok(items.some((i) => i.kind === 'tdata' && i.phone === '+380671234567'), 'из имени папки')
  assert.ok(items.some((i) => i.kind === 'session-file' && i.phone === '+15550001111'), 'из имени файла')

  await fs.rm(root, { recursive: true, force: true })
})

test('scanFolder: облачный пароль из password.txt рядом с аккаунтом', async () => {
  // Продавцы часто кладут 2FA не в json, а отдельным текстовым файлом — без него
  // аккаунт встанет на первом же запросе подтверждения.
  const root = await makeTree()
  const { items } = await scanFolder(root)

  const withPass = items.find((i) => i.name === '+13148766744')
  assert.ok(withPass, 'аккаунт найден')
  assert.equal(withPass.twoFA, 'Ma2xQ', 'пароль прочитан и очищен от перевода строки')

  // json главнее файла: если пароль есть и там, и там, берём из json.
  const fromJson = items.find((i) => i.phone === '+79001112233')
  assert.equal(fromJson.twoFA, 'parol123')

  await fs.rm(root, { recursive: true, force: true })
})

test('readSidecarJson: отпечаток устройства вытаскивается из json продавца', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accscan-fp-'))
  const f = path.join(dir, 'acc.json')
  // Формат распространённых конвертеров: app_id 2040 — официальный Telegram Desktop.
  await fs.writeFile(f, JSON.stringify({
    app_id: 2040, app_hash: 'b18441a1ff607e10a989891a5462e627',
    sdk: 'Windows 11 x64', device: 'SJV50PU', app_version: '6.9.3 x64',
    lang_pack: 'en', system_lang_pack: 'en-US', phone: '19518558554',
  }), 'utf8')

  const meta = await readSidecarJson(f)
  assert.equal(meta.phone, '+19518558554', 'телефон приводится к виду с «+»')
  assert.deepEqual(meta.fingerprint, {
    apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627',
    device: 'SJV50PU', system: 'Windows 11 x64', appVersion: '6.9.3 x64',
    langCode: 'en', systemLangCode: 'en-US',
  })
  await fs.rm(dir, { recursive: true, force: true })
})

test('readSidecarJson: без полей устройства отпечатка нет (а не пустой объект)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accscan-nofp-'))
  const f = path.join(dir, 'acc.json')
  await fs.writeFile(f, JSON.stringify({ phone: '+15550001111' }), 'utf8')
  assert.equal((await readSidecarJson(f)).fingerprint, null)
  await fs.rm(dir, { recursive: true, force: true })
})

test('readSidecarJson: битый json не роняет сканер', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accscan-bad-'))
  const f = path.join(dir, 'broken.json')
  await fs.writeFile(f, '{ это не json', 'utf8')
  assert.equal(await readSidecarJson(f), null)
  await fs.rm(dir, { recursive: true, force: true })
})

test('listDirs: отдаёт только папки и умеет подниматься вверх', async () => {
  const root = await makeTree()
  const { dirs, parent } = await listDirs(root)
  assert.ok(dirs.every((d) => !d.name.endsWith('.txt')), 'файлов в списке нет')
  assert.ok(dirs.some((d) => d.name === 'sessions'))
  assert.ok(parent && parent !== root, 'есть куда подняться')
  await fs.rm(root, { recursive: true, force: true })
})

// ── раздача прокси ──

const items3 = [{ name: 'a' }, { name: 'b', proxy: 'socks5://own:1080' }, { name: 'c' }]

test('distributeProxies: pool — каждому свой, занятые не выдаются (§6)', () => {
  const out = distributeProxies(items3, {
    mode: 'pool',
    proxyUrls: ['socks5://1:1080', 'socks5://2:1080', 'socks5://3:1080'],
    busy: new Set(['socks5://2:1080']),
  })
  assert.deepEqual(out, ['socks5://1:1080', 'socks5://3:1080', null], 'занятый пропущен, третьему не хватило')
})

test('distributeProxies: single — один на всех, sidecar — из json, none — без прокси', () => {
  assert.deepEqual(distributeProxies(items3, { mode: 'single', single: 'socks5://x:1080' }),
    ['socks5://x:1080', 'socks5://x:1080', 'socks5://x:1080'])
  assert.deepEqual(distributeProxies(items3, { mode: 'sidecar' }), [null, 'socks5://own:1080', null])
  assert.deepEqual(distributeProxies(items3, { mode: 'none' }), [null, null, null])
})

// ── Раскладка «аккаунт ↔ прокси» при заливе пачки ──
test('pairByOrder: 1 к 1 по порядку — как лежат аккаунты, так и прокси', async () => {
  const { pairByOrder } = await import('../lib/accountImport.js')
  const accs = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const px = [{ url: 'p1' }, { url: 'p2' }, { url: 'p3' }]
  assert.deepEqual(pairByOrder(accs, px), ['p1', 'p2', 'p3'])
})

test('pairByOrder: прокси меньше, чем аккаунтов — хвост остаётся без прокси', () => {
  // Молча зациклить пул нельзя: это нарушило бы «один прокси — один аккаунт»,
  // а оператор увидел бы «всем раздали» вместо честной нехватки.
  return import('../lib/accountImport.js').then(({ pairByOrder }) => {
    const out = pairByOrder([{}, {}, {}], [{ url: 'p1' }, { url: 'p2' }])
    assert.deepEqual(out, ['p1', 'p2', null])
  })
})

test('pairByOrder: мёртвые прокси не раздаются, если попросили их пропустить', async () => {
  const { pairByOrder } = await import('../lib/accountImport.js')
  const px = [{ url: 'p1', status: 'dead' }, { url: 'p2', status: 'ok' }]
  assert.deepEqual(pairByOrder([{}, {}], px, { skipDead: true }), ['p2', null])
})

test('pairByOrder: гео важнее порядка — украинский аккаунт идёт через украинский IP', async () => {
  const { pairByOrder } = await import('../lib/accountImport.js')
  // Аккаунт из Украины через американский адрес — заметная нестыковка.
  const accs = [{ country: 'us' }, { country: 'ua' }]
  const px = [{ url: 'p_ua', country: 'ua' }, { url: 'p_us', country: 'us' }]
  assert.deepEqual(pairByOrder(accs, px, { matchGeo: true }), ['p_us', 'p_ua'])
})

test('pairByOrder: страна известна не у всех — остаток честно ложится по порядку', async () => {
  const { pairByOrder } = await import('../lib/accountImport.js')
  const accs = [{ country: 'ua' }, {}, {}]
  const px = [{ url: 'p_de', country: 'de' }, { url: 'p_ua', country: 'ua' }, { url: 'p_x' }]
  assert.deepEqual(pairByOrder(accs, px, { matchGeo: true }), ['p_ua', 'p_de', 'p_x'])
})

test('pairByOrder: один прокси не достаётся двум аккаунтам', async () => {
  const { pairByOrder } = await import('../lib/accountImport.js')
  const out = pairByOrder([{ country: 'ua' }, { country: 'ua' }], [{ url: 'p_ua', country: 'ua' }], { matchGeo: true })
  assert.deepEqual(out, ['p_ua', null])
})

test('distributeProxies: manual — раскладку оператора не переставляем', async () => {
  const { distributeProxies } = await import('../lib/accountImport.js')
  const out = distributeProxies([{}, {}, {}], { mode: 'manual', manual: ['p3', null, 'p1'] })
  assert.deepEqual(out, ['p3', null, 'p1'], 'оператор уже видел обе колонки и поправил пары')
})
