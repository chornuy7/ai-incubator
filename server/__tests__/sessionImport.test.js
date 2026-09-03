/**
 * Тесты импорта сессий гоняются на НАСТОЯЩИХ фикстурах: tdata пишем тем же
 * конвертером, что читает Telegram Desktop, SQLite собираем схемой Telethon.
 * Синтетический authKey (256 байт) — в Telegram не ходим, проверяем только формат.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { convertToTdata, convertToGramjsSession, convertFromGramjsSession } from '@mtcute/convert'
import { nodeCryptoProvider } from '../lib/tdataCrypto.js'
import { toGramjsSession, resolveTdataDir, tdataAccountIndexes, isSqlite, ImportError } from '../lib/sessionImport.js'

const AUTH_KEY = new Uint8Array(crypto.randomBytes(256))
const DC = { id: 2, ipAddress: '149.154.167.41', port: 443 }
const sessionData = () => ({
  version: 3,
  primaryDcs: { main: { ...DC }, media: { ...DC, mediaOnly: true } },
  authKey: AUTH_KEY,
  self: { userId: 777000, isBot: false, isPremium: false, usernames: [] },
})

const tmpdir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'sessimport-'))

test('tdata → GramJS StringSession: ключ доезжает байт в байт', async () => {
  const dir = await tmpdir()
  const expected = convertToGramjsSession(sessionData())
  await convertToTdata(sessionData(), { path: dir, crypto: nodeCryptoProvider() })

  const { session, self } = await toGramjsSession({ kind: 'tdata', path: dir })
  assert.equal(session, expected)
  assert.equal(self.userId, 777000)
  // Ключ в восстановленной строке — тот же, что клали.
  assert.ok(Buffer.from(convertFromGramjsSession(session).authKey).equals(Buffer.from(AUTH_KEY)))
  await fs.rm(dir, { recursive: true, force: true })
})

test('resolveTdataDir: находит и саму папку, и вложенную tdata/', async () => {
  const root = await tmpdir()
  const inner = path.join(root, 'tdata')
  await fs.mkdir(inner, { recursive: true })
  await convertToTdata(sessionData(), { path: inner, crypto: nodeCryptoProvider() })

  assert.equal(await resolveTdataDir(inner), inner) // указали прямо на tdata
  assert.equal(await resolveTdataDir(root), inner)  // указали на папку аккаунта
  assert.equal(await resolveTdataDir(path.join(root, 'нет-такой')), null)
  await fs.rm(root, { recursive: true, force: true })
})

test('tdataAccountIndexes: у обычной tdata один аккаунт', async () => {
  const dir = await tmpdir()
  await convertToTdata(sessionData(), { path: dir, crypto: nodeCryptoProvider() })
  const idx = await tdataAccountIndexes(dir)
  assert.ok(Array.isArray(idx) && idx.length >= 1, 'должен быть хотя бы один индекс')
  await fs.rm(dir, { recursive: true, force: true })
})

test('Telethon .session (SQLite) → GramJS StringSession', async () => {
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run('CREATE TABLE sessions (dc_id integer primary key, server_address text, port integer, auth_key blob, takeout_id integer)')
  db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, null)', [DC.id, DC.ipAddress, DC.port, AUTH_KEY])
  const bytes = Buffer.from(db.export())
  db.close()

  assert.ok(isSqlite(bytes), 'фикстура должна распознаваться как SQLite')
  const dir = await tmpdir()
  const file = path.join(dir, 'acc1.session')
  await fs.writeFile(file, bytes)

  const { session } = await toGramjsSession({ kind: 'session-file', path: file })
  assert.ok(session.startsWith('1'), 'GramJS StringSession начинается с версии «1»')
  assert.ok(Buffer.from(convertFromGramjsSession(session).authKey).equals(Buffer.from(AUTH_KEY)))
  await fs.rm(dir, { recursive: true, force: true })
})

test('готовая GramJS-строка в файле импортируется как есть (реимпорт своего же экспорта)', async () => {
  const dir = await tmpdir()
  const str = convertToGramjsSession(sessionData())
  const file = path.join(dir, 'acc.session')
  await fs.writeFile(file, str, 'utf8')

  const { session } = await toGramjsSession({ kind: 'session-file', path: file })
  assert.ok(Buffer.from(convertFromGramjsSession(session).authKey).equals(Buffer.from(AUTH_KEY)))
  await fs.rm(dir, { recursive: true, force: true })
})

test('мусорный файл даёт понятную ошибку, а не падение', async () => {
  const dir = await tmpdir()
  const file = path.join(dir, 'readme.session')
  await fs.writeFile(file, 'это не сессия, а просто текст', 'utf8')

  await assert.rejects(
    () => toGramjsSession({ kind: 'session-file', path: file }),
    (e) => e instanceof ImportError && /не похож|не распознан/i.test(e.message),
  )
  await fs.rm(dir, { recursive: true, force: true })
})

test('isSqlite: отличает бинарь от текста', () => {
  assert.equal(isSqlite(Buffer.from('SQLite format 3\0тут дальше страницы')), true)
  assert.equal(isSqlite(Buffer.from('1AgAOMTQ5LjE1NC4xNjcuNDE')), false)
  assert.equal(isSqlite(Buffer.alloc(4)), false)
})
