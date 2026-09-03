/**
 * §2: крипто-провайдер для чтения tdata — на голом `node:crypto`.
 *
 * Зачем свой: `@mtcute/convert` по умолчанию берёт провайдер из `@mtcute/node`, а тот
 * тянет `better-sqlite3` — нативный модуль, который на проде надо компилировать
 * (на сервере нет тулчейна, и ставить его ради хранилища, которым мы не пользуемся,
 * незачем). Нам от провайдера нужны только хеши и AES-IGE для расшифровки локального
 * ключа Telegram Desktop.
 *
 * AES-IGE в node:crypto нет, поэтому он собран из AES-ECB поблочно — это и есть
 * определение режима IGE. Корректность проверена тестом: расшифровка настоящей tdata
 * даёт тот же результат, что и эталонный провайдер.
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const BLOCK = 16

const xorInto = (out, a, b) => { for (let i = 0; i < out.length; i++) out[i] = a[i] ^ b[i] }

/** Один блок AES без паддинга — кирпич, из которого складывается IGE. */
function aesBlock(key, block, encrypt) {
  const algo = `aes-${key.length * 8}-ecb`
  const c = encrypt ? crypto.createCipheriv(algo, key, null) : crypto.createDecipheriv(algo, key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(block), c.final()])
}

/**
 * AES-IGE (Infinite Garble Extension) — режим, который использует Telegram.
 * `iv` — 32 байта: первая половина играет роль предыдущего блока шифротекста,
 * вторая — предыдущего блока открытого текста.
 * @param {Uint8Array} key @param {Uint8Array} iv
 */
export function createAesIge(key, iv) {
  const k = Buffer.from(key)
  const iv0 = Buffer.from(iv)

  const run = (data, encrypt) => {
    const input = Buffer.from(data)
    if (input.length % BLOCK !== 0) throw new Error('AES-IGE: длина данных не кратна 16')
    const out = Buffer.alloc(input.length)
    const tmp = Buffer.alloc(BLOCK)
    // Каноническое определение IGE: IV делится пополам на iv1 и iv2. После каждого блока
    // iv1 становится блоком ШИФРОТЕКСТА, iv2 — блоком ОТКРЫТОГО текста, независимо от
    // направления. Различаются только роли: при шифровании iv1 подмешивается ДО,
    // iv2 — ПОСЛЕ; при расшифровке наоборот.
    let iv1 = iv0.subarray(0, BLOCK)
    let iv2 = iv0.subarray(BLOCK, BLOCK * 2)

    for (let off = 0; off < input.length; off += BLOCK) {
      const cur = input.subarray(off, off + BLOCK)
      const res = out.subarray(off, off + BLOCK)
      if (encrypt) {
        xorInto(tmp, cur, iv1)
        xorInto(res, aesBlock(k, tmp, true), iv2)
        iv1 = res // шифротекст
        iv2 = cur // открытый текст
      } else {
        xorInto(tmp, cur, iv2)
        xorInto(res, aesBlock(k, tmp, false), iv1)
        iv1 = cur // шифротекст
        iv2 = res // открытый текст
      }
    }
    return new Uint8Array(out)
  }

  return {
    encrypt: (data) => run(data, true),
    decrypt: (data) => run(data, false),
  }
}

const hash = (algo, data) => new Uint8Array(crypto.createHash(algo).update(Buffer.from(data)).digest())

/**
 * Провайдер в формате, который ждёт @mtcute/convert (IExtendedCryptoProvider).
 * Методы, не нужные для чтения tdata (factorizePQ, AES-CTR), реализованы честно
 * там, где это дёшево, и явно бросают там, где нет — молчаливая заглушка хуже ошибки.
 */
export function nodeCryptoProvider() {
  return {
    sha1: (data) => hash('sha1', data),
    sha256: (data) => hash('sha256', data),
    createHash: (algorithm) => {
      const h = crypto.createHash(algorithm)
      return {
        update: (data) => { h.update(Buffer.from(data)) },
        digest: () => new Uint8Array(h.digest()),
      }
    },
    pbkdf2: (password, salt, iterations, keylen = 64, algo = 'sha512') =>
      new Promise((resolve, reject) => {
        crypto.pbkdf2(Buffer.from(password), Buffer.from(salt), iterations, keylen, algo, (err, buf) => {
          if (err) reject(err); else resolve(new Uint8Array(buf))
        })
      }),
    hmacSha256: (data, key) => new Uint8Array(crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()),
    createAesIge,
    createAesCtr: (key, iv, _encrypt) => {
      const c = crypto.createCipheriv(`aes-${key.length * 8}-ctr`, Buffer.from(key), Buffer.from(iv))
      return { process: (data) => new Uint8Array(c.update(Buffer.from(data))), close: () => { try { c.final() } catch { /* поток без хвоста */ } } }
    },
    factorizePQ: () => { throw new Error('factorizePQ не нужен для чтения tdata') },
    gzip: (data, maxSize) => {
      const out = zlib.gzipSync(Buffer.from(data))
      return out.length > maxSize ? null : new Uint8Array(out)
    },
    gunzip: (data) => new Uint8Array(zlib.gunzipSync(Buffer.from(data))),
    randomFill: (buf) => { crypto.randomFillSync(buf) },
    randomBytes: (size) => new Uint8Array(crypto.randomBytes(size)),
  }
}
