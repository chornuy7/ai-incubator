/**
 * Владелец нового Telegram-аккаунта (правка 27.08).
 *
 * Жалоба владельца: «с новых аккаунтов не удаётся добавить аккаунты Telegram». Вход по
 * номеру проходил, сессия сохранялась — и аккаунт тут же пропадал с экрана: владельца ему
 * никто не проставлял, а список режется по владельцу, и «ничей» виден только админу.
 * Человек добавлял один и тот же номер по кругу.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'acc-owner-'))
const { setAccountMeta, getAccountMeta } = await import('../accountsMeta.js')

/** Та же развилка, что в finalizeAuth: владельца ставим новому или «ничейному». */
async function запиши(accountId, ownerId) {
  const было = await getAccountMeta(accountId).catch(() => ({}))
  const ставим = ownerId && !было?.ownerId
  await setAccountMeta(accountId, { ...(ставим ? { ownerId: String(ownerId) } : {}), status: 'active' })
  return (await getAccountMeta(accountId)).ownerId || null
}

test('новый аккаунт достаётся тому, кто его завёл', async () => {
  assert.equal(await запиши('acc_new', 'usr_owner'), 'usr_owner')
})

test('реавторизация чужого аккаунта владельца не переписывает', async () => {
  await запиши('acc_client', 'usr_client')
  // Админ входит за клиента, чтобы починить сессию: аккаунт обязан остаться клиентским,
  // иначе он молча переехал бы в другое пространство.
  assert.equal(await запиши('acc_client', 'usr_admin'), 'usr_client')
})

test('старому «ничейному» аккаунту владелец проставляется при первом же входе', async () => {
  await setAccountMeta('acc_legacy', { status: 'active' })
  assert.equal(await запиши('acc_legacy', 'usr_owner'), 'usr_owner')
})

test('без сессии (дев) владельца не выдумываем', async () => {
  assert.equal(await запиши('acc_dev', ''), null)
})
