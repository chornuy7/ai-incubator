/**
 * AES-IGE написан руками (в node:crypto его нет), поэтому проверяем его как криптографию:
 * round-trip, известные свойства режима и совпадение с эталонной реализацией из
 * @mtcute/convert — она используется как источник истины через convertToTdata/convertFromTdata.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { convertToTdata, convertFromTdata, convertToGramjsSession } from '@mtcute/convert'
import { createAesIge, nodeCryptoProvider } from '../lib/tdataCrypto.js'

const KEY = crypto.randomBytes(32)
const IV = crypto.randomBytes(32)

test('AES-IGE: расшифровка возвращает исходные данные', () => {
  const plain = crypto.randomBytes(16 * 5)
  const enc = createAesIge(KEY, IV).encrypt(plain)
  const dec = createAesIge(KEY, IV).decrypt(enc)
  assert.deepEqual(Buffer.from(dec), plain)
  assert.notDeepEqual(Buffer.from(enc), plain, 'шифротекст обязан отличаться от открытого текста')
})

test('AES-IGE: одинаковые блоки шифруются по-разному (в этом весь смысл режима)', () => {
  // Если бы это был ECB, два одинаковых блока дали бы одинаковый шифротекст.
  const plain = Buffer.concat([Buffer.alloc(16, 7), Buffer.alloc(16, 7)])
  const enc = Buffer.from(createAesIge(KEY, IV).encrypt(plain))
  assert.notDeepEqual(enc.subarray(0, 16), enc.subarray(16, 32))
})

test('AES-IGE: другой IV — другой результат; длина не кратна блоку — ошибка', () => {
  const plain = crypto.randomBytes(32)
  const a = Buffer.from(createAesIge(KEY, IV).encrypt(plain))
  const b = Buffer.from(createAesIge(KEY, crypto.randomBytes(32)).encrypt(plain))
  assert.notDeepEqual(a, b)
  assert.throws(() => createAesIge(KEY, IV).encrypt(crypto.randomBytes(20)), /не кратна/)
})

test('провайдер даёт те же хеши, что node:crypto', async () => {
  const p = nodeCryptoProvider()
  const data = Buffer.from('проверка хешей')
  assert.deepEqual(Buffer.from(p.sha1(data)), crypto.createHash('sha1').update(data).digest())
  assert.deepEqual(Buffer.from(p.sha256(data)), crypto.createHash('sha256').update(data).digest())
  const h = p.createHash('md5')
  await h.update(data)
  assert.deepEqual(Buffer.from(await h.digest()), crypto.createHash('md5').update(data).digest())
})

test('AES-IGE совпадает с эталонной реализацией (зафиксированный вектор)', () => {
  // Вектор снят с NodeCryptoProvider из @mtcute/node — того самого провайдера, который
  // мы заменили своим. Пакет удалён из зависимостей (тянул нативный better-sqlite3,
  // а на проде нет тулчейна), поэтому эталон зафиксирован здесь константой: если
  // реализация «поедет», тест это поймает без внешних пакетов.
  const key = Buffer.alloc(32); for (let i = 0; i < 32; i++) key[i] = i
  const iv = Buffer.alloc(32); for (let i = 0; i < 32; i++) iv[i] = 255 - i
  const plain = Buffer.from('IGE known answer vector 0123456789abcdef!!'.padEnd(48, '.'))
  const expected = '3658bb3297be50b2897a90c61d783b2dbe001d7550fd10df1d4bd8862879d1292a6059a3baa7c673feffd867030a5e36'

  assert.equal(Buffer.from(createAesIge(key, iv).encrypt(plain)).toString('hex'), expected)
  assert.deepEqual(Buffer.from(createAesIge(key, iv).decrypt(Buffer.from(expected, 'hex'))), plain)
})

test('tdata, записанная и прочитанная нашим провайдером, даёт ту же сессию', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdatacrypto-'))
  const data = {
    version: 3,
    primaryDcs: {
      main: { id: 2, ipAddress: '149.154.167.41', port: 443 },
      media: { id: 2, ipAddress: '149.154.167.41', port: 443, mediaOnly: true },
    },
    authKey: new Uint8Array(crypto.randomBytes(256)),
    self: { userId: 777000, isBot: false, isPremium: false, usernames: [] },
  }
  const cryptoProvider = nodeCryptoProvider()
  await convertToTdata(data, { path: dir, crypto: cryptoProvider })

  const ours = convertToGramjsSession(await convertFromTdata({ path: dir, crypto: cryptoProvider }, 0))
  assert.equal(ours, convertToGramjsSession(data), 'сессия из tdata должна совпасть с исходной')

  await fs.rm(dir, { recursive: true, force: true })
})
