/**
 * §10.3: закрытые API-ключи «мозгов». Ключ показывается один раз, дальше только
 * префикс; отозванный не пускает; чужой формат — мимо.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

async function fresh() {
  const f = path.join(os.tmpdir(), `apikeys-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  process.env.API_KEYS_FILE = f
  await fs.rm(f, { force: true })
  return { K: await import('../apiKeys.js?k=' + Math.random()), f }
}

test('выпуск отдаёт полный ключ один раз, список — только префикс + пользователь', async () => {
  const { K, f } = await fresh()
  const issued = await K.issueKey({ name: 'Мозги', userId: 'usr_777' })
  assert.ok(issued.key.startsWith('aii_live_sk_'), 'ключ с префиксом')
  assert.equal(issued.ownerId, 'usr_777', 'выпущен для пользователя')
  const list = await K.listKeys()
  assert.equal(list.length, 1)
  assert.ok(!('key' in list[0]), 'полного ключа в списке нет')
  assert.ok(list[0].prefix.endsWith('…'), 'только префикс')
  assert.equal(list[0].ownerId, 'usr_777', 'в списке видно пользователя')
  await fs.rm(f, { force: true })
})

test('ключ выпускается ТОЛЬКО для пользователя — без него ошибка', async () => {
  const { K, f } = await fresh()
  await assert.rejects(() => K.issueKey({ name: 'Без юзера' }), /пользовател/i, 'нет пользователя — не выпускаем')
  await fs.rm(f, { force: true })
})

test('verifyKey: валидный проходит и отдаёт пользователя; отозванный и чужой — нет', async () => {
  const { K, f } = await fresh()
  const issued = await K.issueKey({ name: 'X', userId: 'usr_42' })
  const ok = await K.verifyKey('Bearer ' + issued.key)
  assert.ok(ok, 'валидный проходит')
  assert.equal(ok.ownerId, 'usr_42', 'verifyKey отдаёт пользователя ключа')
  assert.ok(await K.verifyKey(issued.key), 'без Bearer тоже')
  assert.equal(await K.verifyKey('aii_live_sk_нет-такого'), null, 'чужой — null')
  assert.equal(await K.verifyKey('какой-то-мусор'), null, 'не наш формат — null')
  await K.revokeKey(issued.id)
  assert.equal(await K.verifyKey(issued.key), null, 'отозванный не пускает')
  await fs.rm(f, { force: true })
})

test('revokeKey: неизвестный id — false', async () => {
  const { K, f } = await fresh()
  assert.equal(await K.revokeKey('key_нет'), false)
  await fs.rm(f, { force: true })
})
