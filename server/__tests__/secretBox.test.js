/**
 * MR-290: облачные пароли аккаунтов (2FA) в базе — только в шифрованном виде.
 *
 * Проверяем не «крипта работает» (она из node:crypto и в проверке не нуждается), а
 * ПРАВИЛА ХРАНЕНИЯ, которые легко потерять при следующей правке:
 *   • старое значение открытым текстом продолжает читаться, иначе переход потребовал бы
 *     одномоментной остановки;
 *   • без ключа секрет НЕ уезжает в общую базу молча;
 *   • подмена шифротекста не проходит незамеченной;
 *   • чужой ключ даёт понятную ошибку, а не мусор вместо пароля;
 *   • пароль не попадает в объект меты, который ходит по всему коду и уезжает в API.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const KEY_A = crypto.randomBytes(32).toString('base64')
const KEY_B = crypto.randomBytes(32).toString('base64')

/**
 * Свежий экземпляр модуля с заданным ключом. Ключ разбирается один раз за жизнь модуля
 * (он не меняется у запущенного процесса), поэтому на каждый сценарий нужен свой импорт.
 */
let seq = 0
async function withKey(value) {
  if (value === null) delete process.env.SECRETS_KEY
  else process.env.SECRETS_KEY = value
  return import(`../lib/secretBox.js?case=${++seq}`)
}

test('шифрование и расшифровка возвращают то же значение', async () => {
  const box = await withKey(KEY_A)
  const enc = box.encryptSecret('Ma200')
  assert.notEqual(enc, 'Ma200', 'в базу не должен уезжать открытый текст')
  assert.ok(box.isEncrypted(enc))
  assert.equal(box.decryptSecret(enc), 'Ma200')
})

test('один и тот же пароль каждый раз даёт разный шифротекст', async () => {
  // Иначе по базе видно, у каких аккаунтов пароль совпадает, — а это уже подсказка.
  const box = await withKey(KEY_A)
  assert.notEqual(box.encryptSecret('C19A80'), box.encryptSecret('C19A80'))
})

test('пустой пароль остаётся пустым, а не превращается в секрет', async () => {
  // «Пароля нет» — не тайна. Завернув пустое в конверт, мы сделали бы его неотличимым
  // от «пароль есть», и признак has2fa начал бы врать.
  const box = await withKey(KEY_A)
  assert.equal(box.encryptSecret(''), null)
  assert.equal(box.encryptSecret(null), null)
  assert.equal(box.decryptSecret(null), null)
})

test('старое значение открытым текстом читается как есть', async () => {
  // Скрипт перешифровки идёт ПОСЛЕ выката кода, и до него в базе лежит и то, и другое.
  const box = await withKey(KEY_A)
  assert.equal(box.decryptSecret('старый-пароль-как-был'), 'старый-пароль-как-был')
  assert.equal(box.isEncrypted('старый-пароль-как-был'), false)
})

test('подменённый шифротекст не расшифровывается', async () => {
  const box = await withKey(KEY_A)
  const enc = box.encryptSecret('секрет')
  const parts = enc.split('.')
  parts[5] = Buffer.from('подделка').toString('base64url')
  assert.throws(() => box.decryptSecret(parts.join('.')))
})

test('чужой ключ — понятная ошибка, а не мусор вместо пароля', async () => {
  const boxA = await withKey(KEY_A)
  const enc = boxA.encryptSecret('секрет')
  const boxB = await withKey(KEY_B)
  assert.throws(() => boxB.decryptSecret(enc), /другим ключом|перешифровка/i)
})

test('без ключа секрет НЕ уезжает в общую базу молча', async () => {
  const box = await withKey(null)
  assert.equal(box.secretsKeyConfigured(), false)
  // Общая база — отказ: видимая ошибка при импорте дешевле ещё одного пароля открытым
  // текстом на проде.
  assert.throws(() => box.secretForStorage('пароль', true), /SECRETS_KEY/)
  // Локальное хранилище (тесты, дев) — как раньше: там нет ни общей базы, ни бэкапов.
  assert.equal(box.secretForStorage('пароль', false), 'пароль')
})

test('ключ неверной длины отвергается сразу, а не при первой записи', async () => {
  const box = await withKey(Buffer.from('коротко').toString('base64'))
  assert.throws(() => box.secretsKeyConfigured(), /32 байта/)
})

test('строка сессии не сохраняется открытым текстом', async () => {
  // Сессия — уже пройденная авторизация: ей не нужен ни телефон, ни код, ни облачный
  // пароль. Лежала файлом открытым текстом, то есть копия каталога = копия всех
  // аккаунтов. Теперь она строка таблицы и шифруется тем же ключом (MR-290).
  const auth = await fs.readFile(new URL('../tgAuth.js', import.meta.url), 'utf8')
  assert.ok(!/writeFile\(sessionFile\(accountId\), sessionString/.test(auth),
    'сессия больше не пишется в файл как есть')
  assert.match(auth, /secretForStorage\(sessionString, true\)/, 'в базу уезжает шифротекст')
  assert.match(auth, /decryptSecret\(data\.session_enc\)/, 'из базы читается через расшифровку')

  const sql = await fs.readFile(new URL('../../supabase/migrations/2026-09-01-mr290-account-sessions.sql', import.meta.url), 'utf8')
  const flat = sql.replace(/\s+/g, ' ')
  assert.ok(flat.includes('references accounts_meta(id) on delete cascade'),
    'удалили аккаунт — сессия уходит с ним, иначе останется живой доступ к несуществующему аккаунту')
})

test('пароль не попадает в объект меты и в ответ API', async () => {
  // Пароль лежал в data-jsonb, а loadAllMeta читает data целиком — значит объект меты
  // носил его по всему коду, и одной строки `res.json(meta)` хватило бы, чтобы отдать
  // наружу. Теперь мета несёт только признак.
  const meta = await fs.readFile(new URL('../accountsMeta.js', import.meta.url), 'utf8')
  assert.match(meta, /stripSecrets/, 'мета обязана вычищать секреты перед отдачей')
  assert.match(meta, /has2fa = !!\(r\.two_fa_enc/, 'наружу идёт признак, а не значение')

  const dto = await fs.readFile(new URL('../tgAccounts.js', import.meta.url), 'utf8')
  assert.ok(!/has2fa:\s*!!meta\.twoFA/.test(dto), 'DTO больше не читает пароль из меты')
  assert.match(dto, /has2fa: !!meta\.has2fa/)
})
