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

test('выпуск отдаёт полный ключ один раз, список — только префикс + аккаунт', async () => {
  const { K, f } = await fresh()
  const issued = await K.issueKey({ name: 'Мозги', accountId: 'acc_777' })
  assert.ok(issued.key.startsWith('aii_live_sk_'), 'ключ с префиксом')
  assert.equal(issued.accountId, 'acc_777', 'привязан к аккаунту')
  const list = await K.listKeys()
  assert.equal(list.length, 1)
  assert.ok(!('key' in list[0]), 'полного ключа в списке нет')
  assert.ok(list[0].prefix.endsWith('…'), 'только префикс')
  assert.equal(list[0].accountId, 'acc_777', 'в списке видно аккаунт')
  await fs.rm(f, { force: true })
})

test('ключ выпускается ТОЛЬКО под аккаунт — без него ошибка', async () => {
  const { K, f } = await fresh()
  await assert.rejects(() => K.issueKey({ name: 'Без акка' }), /аккаунт/i, 'нет аккаунта — не выпускаем')
  await fs.rm(f, { force: true })
})

test('verifyKey: валидный проходит и отдаёт аккаунт; отозванный и чужой — нет', async () => {
  const { K, f } = await fresh()
  const issued = await K.issueKey({ name: 'X', accountId: 'acc_42' })
  const ok = await K.verifyKey('Bearer ' + issued.key)
  assert.ok(ok, 'валидный проходит')
  assert.equal(ok.accountId, 'acc_42', 'verifyKey отдаёт привязанный аккаунт')
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
