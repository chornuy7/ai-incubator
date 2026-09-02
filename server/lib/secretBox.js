/**
 * MR-290: секреты, которые обязаны лежать в базе, но не должны читаться из неё глазами.
 *
 * Повод. В `accounts_meta.data.twoFA` открытым текстом лежал ОБЛАЧНЫЙ ПАРОЛЬ (2FA)
 * Telegram-аккаунта — у 47 аккаунтов из 63. Его собирает импорт из `password.txt` и
 * json-описаний рядом с сессией (см. accountScan.js), и хранится он не зря: без пароля
 * аккаунт нельзя реавторизовать, когда сессия отвалится, а взять его потом неоткуда.
 * То есть удалить нельзя, а держать как есть — значит отдавать полный доступ к аккаунту
 * любому, кто получил дамп базы или ключ только на чтение.
 *
 * ─── ПОЧЕМУ ШИФРУЕМ ЗДЕСЬ, А НЕ В БАЗЕ ───
 *
 * В базе есть и pgcrypto, и Supabase Vault (`vault` 0.3.1, установлен). Соблазнительно
 * шифровать средствами Postgres — но тогда БАЗА ЗНАЕТ И КЛЮЧ, И ОТКРЫТЫЙ ТЕКСТ:
 *
 *   • Supabase Vault хранит ключ В ТОЙ ЖЕ БАЗЕ, а расшифровку отдаёт представлением
 *     `vault.decrypted_secrets`. Бэкенд ходит сервисным ключом и читает его свободно —
 *     значит, тот же самый доступ, которым злоумышленник прочитал бы пароль, даёт ему и
 *     ключ. От утечки дампа Vault защищает, от доступа к базе — нет;
 *   • при шифровании через SQL открытый текст ЕДЕТ В ЗАПРОСЕ и оседает там, где запросы
 *     видны: pg_stat_statements, логи, история SQL Editor.
 *
 * Поэтому шифруем в приложении: в базу уезжает уже шифротекст, ключ в базу не попадает
 * никогда. Тогда дамп, реплика, бэкап, ключ «только на чтение» и панель Supabase не дают
 * ничего. Остаётся один сценарий, где пароль всё же достанут, — полный доступ к серверу
 * приложения; от него не спасает никакая схема хранения, кроме «не хранить вовсе».
 *
 * ─── КЛЮЧ ───
 *
 * `SECRETS_KEY` — 32 байта в base64. Откуда он приезжает в окружение (HashiCorp Vault,
 * KMS, секрет GitHub Actions) — вопрос выката, не кода; коду важно лишь, что в базе его
 * нет. Сгенерировать: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
 *
 * ⚠️ ПОТЕРЯ КЛЮЧА = ПОТЕРЯ ПАРОЛЕЙ. Восстановить их неоткуда: в Telegram облачный пароль
 * не прочитать, а импортированные архивы у оператора вряд ли сохранились. Ключ обязан
 * лежать в двух местах, и второе — не тот же сервер.
 *
 * ─── ФОРМАТ ───
 *
 * `enc.v1.<keyId>.<iv>.<tag>.<ciphertext>` — всё base64url, кроме первых двух меток.
 * `keyId` — восемь символов от sha256 ключа: по нему видно, каким ключом зашифровано, и
 * ротация перестаёт быть «расшифруй всё вслепую и молись». Значение без префикса `enc.`
 * считается старым открытым текстом и возвращается как есть — иначе переход потребовал
 * бы одномоментной остановки.
 */
import crypto from 'node:crypto'

const PREFIX = 'enc'
const VERSION = 'v1'
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // рекомендованная длина nonce для GCM
const b64 = (buf) => Buffer.from(buf).toString('base64url')
const unb64 = (s) => Buffer.from(String(s), 'base64url')

let _key = null
let _keyId = null
let _warned = false

/** Ключ из окружения. Разбираем один раз: он не меняется в течение жизни процесса. */
function key() {
  if (_key !== null) return _key
  const raw = String(process.env.SECRETS_KEY || '').trim()
  if (!raw) { _key = false; return _key }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(`SECRETS_KEY должен быть 32 байта в base64, а получилось ${buf.length}. Сгенерировать: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
  }
  _key = buf
  _keyId = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)
  return _key
}

/** Настроен ли ключ. Нужно проверке при старте и скрипту перешифровки. */
export function secretsKeyConfigured() {
  return key() !== false
}

/** Отпечаток текущего ключа — чтобы в логах и отчётах не гадать, каким шифровали. */
export function secretsKeyId() {
  key()
  return _keyId
}

/** Похоже ли значение на наш конверт (а не на старый открытый текст). */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}.${VERSION}.`)
}

/**
 * Зашифровать. Пустое значение остаётся пустым: «пароля нет» — это не секрет, и
 * заворачивать его в конверт значило бы сделать неотличимым от «пароль есть».
 * @param {string|null|undefined} plain @returns {string|null}
 */
export function encryptSecret(plain) {
  const text = plain == null ? '' : String(plain)
  if (!text) return null
  const k = key()
  if (k === false) throw new Error('Нет SECRETS_KEY — шифровать нечем. Секрет НЕ сохранён (MR-290).')
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, k, iv)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [PREFIX, VERSION, _keyId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.')
}

/**
 * Расшифровать. Значение без конверта — старый открытый текст, отдаём как есть: пока
 * скрипт перешифровки не прошёл, в базе лежит и то, и другое.
 * @param {string|null|undefined} stored @returns {string|null}
 */
export function decryptSecret(stored) {
  if (stored == null || stored === '') return null
  const value = String(stored)
  if (!isEncrypted(value)) return value
  const [, , keyId, ivB64, tagB64, ctB64] = value.split('.')
  const k = key()
  if (k === false) throw new Error('Нет SECRETS_KEY — расшифровать нечем.')
  if (keyId !== _keyId) {
    throw new Error(`Секрет зашифрован другим ключом (${keyId}), сейчас настроен ${_keyId}. Нужен прежний ключ или перешифровка.`)
  }
  const decipher = crypto.createDecipheriv(ALGO, k, unb64(ivB64))
  decipher.setAuthTag(unb64(tagB64))
  return Buffer.concat([decipher.update(unb64(ctB64)), decipher.final()]).toString('utf8')
}

/**
 * Значение для записи в базу с учётом режима работы.
 *
 * Без ключа: на общей базе — отказ, потому что молча положить в прод ещё один пароль
 * открытым текстом хуже, чем видимая ошибка при импорте. На файловом хранилище
 * (локальный запуск и тесты) — как раньше, но с предупреждением: там нет ни общей базы,
 * ни бэкапов, ни чужих глаз, и требовать ключ значило бы сломать всем локальную работу.
 * @param {string|null|undefined} plain @param {boolean} sharedDb работаем с общей базой
 */
export function secretForStorage(plain, sharedDb) {
  const text = plain == null ? '' : String(plain)
  if (!text) return null
  if (secretsKeyConfigured()) return encryptSecret(text)
  if (sharedDb) {
    throw new Error('Секрет не сохранён: не задан SECRETS_KEY, а класть пароль в общую базу открытым текстом нельзя (MR-290).')
  }
  if (!_warned) {
    _warned = true
    console.warn('[secrets] SECRETS_KEY не задан — секреты хранятся открытым текстом. Допустимо только для локального запуска и тестов.')
  }
  return text
}
