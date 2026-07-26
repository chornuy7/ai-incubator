/**
 * §5.1: срок подписки (expiresAt). Покупка на N месяцев ставит дату окончания;
 * без периода — бессрочно (null, демо). Личная подписка перекрывает пространство
 * и по набору, и по сроку.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const D = 86_400_000

process.env.BALANCE_FILE = path.join(os.tmpdir(), `subper-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
await fs.rm(process.env.BALANCE_FILE, { force: true })
const B = await import('../balance.js')

test('покупка на месяц → срок около 30 дней вперёд', async () => {
  await B.setUserModules(['mailing'], 'u1', { months: 1 })
  const b = await B.getBalance('u1')
  assert.deepEqual(b.modules, ['mailing'])
  assert.ok(b.expiresAt > Date.now(), 'срок в будущем')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days > 25 && days < 35, `около 30 дней, получили ${days}`)
})

test('без периода → бессрочно (null)', async () => {
  await B.setUserModules(['ggr'], 'u2')
  assert.equal((await B.getBalance('u2')).expiresAt, null)
})

test('годовая подписка пространства → около 360 дней, наследуется без личной', async () => {
  await B.setModules('all', undefined, { months: 12 })
  const b = await B.getBalance('u3') // у u3 нет личной подписки — берёт пространство
  assert.equal(b.modules, 'all')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days > 340 && days < 375, `около 360 дней, получили ${days}`)
})

test('личная подписка перекрывает пространство и по сроку', async () => {
  // u1 купил личный набор на месяц; пространство — на год. У u1 действует личный срок.
  const b = await B.getBalance('u1')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days < 35, `личный месячный срок, а не годовой пространства (${days})`)
})
