/**
 * §5.1: журнал операций по кошельку. Без него на вопрос клиента «за что списали
 * 12 монет» ответить нечем — баланс показывает только «сколько сейчас».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

async function fresh() {
  const dir = path.join(os.tmpdir(), `wallet-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.BALANCE_FILE = path.join(dir, 'balance.json')
  process.env.WALLET_LOG_FILE = path.join(dir, 'wallet-log.jsonl')
  return { B: await import('../balance.js?w=' + Math.random()), dir }
}

test('каждое изменение попадает в журнал с «до» и «после»', async () => {
  const { B, dir } = await fresh()
  await B.changeCoins(10, 'пополнение', 'usr_a')
  await B.changeCoins(-2.5, 'парсер: 500 строк', 'usr_a')

  const rows = await B.walletHistory({ userId: 'usr_a' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].reason, 'парсер: 500 строк', 'свежие сверху')
  assert.equal(rows[0].amount, -2.5)
  assert.equal(rows[0].before, 10)
  assert.equal(rows[0].after, 7.5)
  assert.equal(rows[1].amount, 10)
  await fs.rm(dir, { recursive: true, force: true })
})

test('журнал у каждого свой', async () => {
  const { B, dir } = await fresh()
  await B.changeCoins(5, 'a', 'usr_a')
  await B.changeCoins(7, 'b', 'usr_b')
  assert.equal((await B.walletHistory({ userId: 'usr_a' })).length, 1)
  assert.equal((await B.walletHistory({ userId: 'usr_b' })).length, 1)
  assert.equal((await B.walletHistory({})).length, 2, 'без фильтра — все, для админки')
  await fs.rm(dir, { recursive: true, force: true })
})

test('нулевое изменение журнал не засоряет', async () => {
  const { B, dir } = await fresh()
  await B.changeCoins(0, 'ничего не произошло', 'usr_a')
  assert.equal((await B.walletHistory({ userId: 'usr_a' })).length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('битая строка не роняет весь журнал', async () => {
  const { B, dir } = await fresh()
  await B.changeCoins(3, 'ок', 'usr_a')
  await fs.appendFile(process.env.WALLET_LOG_FILE, 'это не json\n', 'utf8')
  await B.changeCoins(4, 'тоже ок', 'usr_a')
  const rows = await B.walletHistory({ userId: 'usr_a' })
  assert.equal(rows.length, 2, 'обе валидные строки на месте')
  await fs.rm(dir, { recursive: true, force: true })
})

test('пустой журнал — пустой список, а не падение', async () => {
  const { B, dir } = await fresh()
  assert.deepEqual(await B.walletHistory({ userId: 'usr_нет' }), [])
  await fs.rm(dir, { recursive: true, force: true })
})
