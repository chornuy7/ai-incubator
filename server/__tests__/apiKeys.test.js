/**
 * §10.3 / §11.8: доступ к приватному API — по сервисному env-ключу. Ключи под
 * пользователя больше не выпускаются; остаются verify (env + легаси), list и revoke.
 * Проверяем: список — только префикс; отозванный не пускает; чужой формат — мимо;
 * env-ключ проходит до префикса/БД и отдаёт владельца из окружения.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

const PREFIX = 'aii_live_sk_'

async function fresh() {
  const f = path.join(os.tmpdir(), `apikeys-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  process.env.API_KEYS_FILE = f
  await fs.rm(f, { force: true })
  return { K: await import('../apiKeys.js?k=' + Math.random()), f }
}

/** Засеять легаси-ключ прямо в файл (issueKey убран по §11.8 — генерации больше нет). */
async function seedKey(file, { id = 'key_test', name = 'Легаси', key, ownerId = 'usr_777' }) {
  const prefix = key.slice(0, PREFIX.length + 6) + '…'
  const rec = { id, name, key, prefix, ownerId, createdAt: Date.now(), lastUsedAt: 0, revoked: false }
  await fs.writeFile(file, JSON.stringify([rec]))
  return rec
}

test('список ключей — только префикс + пользователь, без полного значения', async () => {
  const { K, f } = await fresh()
  await seedKey(f, { key: PREFIX + 'abcdef0123456789', ownerId: 'usr_777' })
  const list = await K.listKeys()
  assert.equal(list.length, 1)
  assert.ok(!('key' in list[0]), 'полного ключа в списке нет')
  assert.ok(list[0].prefix.endsWith('…'), 'только префикс')
  assert.equal(list[0].ownerId, 'usr_777', 'в списке виден пользователь легаси-ключа')
  await fs.rm(f, { force: true })
})

test('verifyKey: валидный легаси-ключ проходит; отозванный и чужой — нет', async () => {
  const { K, f } = await fresh()
  const rec = await seedKey(f, { id: 'key_42', key: PREFIX + 'valid0000000000000000', ownerId: 'usr_42' })
  const ok = await K.verifyKey('Bearer ' + rec.key)
  assert.ok(ok, 'валидный проходит')
  assert.equal(ok.ownerId, 'usr_42', 'verifyKey отдаёт пользователя ключа')
  assert.ok(await K.verifyKey(rec.key), 'без Bearer тоже')
  assert.equal(await K.verifyKey(PREFIX + 'нет-такого'), null, 'чужой — null')
  assert.equal(await K.verifyKey('какой-то-мусор'), null, 'не наш формат — null')
  await K.revokeKey(rec.id)
  assert.equal(await K.verifyKey(rec.key), null, 'отозванный не пускает')
  await fs.rm(f, { force: true })
})

test('revokeKey: неизвестный id — false', async () => {
  const { K, f } = await fresh()
  assert.equal(await K.revokeKey('key_нет'), false)
  await fs.rm(f, { force: true })
})

test('сервисный env-ключ: проходит до префикса/БД, отдаёт владельца из env', async () => {
  const { K, f } = await fresh()
  process.env.MURMEX_API_KEY = 'service-secret-xyz' // намеренно без префикса aii_live_sk_
  process.env.MURMEX_API_KEY_OWNER = 'usr_boss'
  assert.ok(K.serviceKeyConfigured(), 'ключ задан в окружении')
  const ok = await K.verifyKey('Bearer service-secret-xyz')
  assert.ok(ok, 'env-ключ проходит')
  assert.equal(ok.ownerId, 'usr_boss', 'действует от имени владельца из env')
  assert.equal(ok.service, true, 'помечен как сервисный')
  assert.equal(await K.verifyKey('Bearer service-secret-XXX'), null, 'неверное значение — null')

  // Без владельца — системный режим (ownerId пуст → RBAC даёт полный доступ).
  delete process.env.MURMEX_API_KEY_OWNER
  const sys = await K.verifyKey('service-secret-xyz')
  assert.equal(sys.ownerId, '', 'без OWNER — системный ключ без пользователя')

  // Снятие ключа из env закрывает доступ.
  delete process.env.MURMEX_API_KEY
  assert.ok(!K.serviceKeyConfigured(), 'ключа больше нет')
  assert.equal(await K.verifyKey('service-secret-xyz'), null, 'без env-ключа — null')
  await fs.rm(f, { force: true })
})
