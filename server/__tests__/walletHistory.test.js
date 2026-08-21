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

/**
 * Сотрудник с ОБЩИМ балансом (§4.2, MR-30): деньги у него не свои, а владельца.
 *
 * Записи в журнал идут под владельцем кошелька (`changeCoins` зовёт resolveWalletOwner),
 * а история раньше фильтровалась по своему id. Получалось расхождение, которое владелец
 * и увидел 21.08: в шапке деньги владельца, они на глазах тратятся, а в «Истории
 * операций» пусто — «купил подписки, тратил деньги, выдал баланс, нету ничего».
 * Баланс и история обязаны описывать ОДИН кошелёк.
 */
test('сотрудник с общим балансом видит историю того кошелька, что и в шапке', async () => {
  const dir = path.join(os.tmpdir(), `wallet-shared-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.BALANCE_FILE = path.join(dir, 'balance.json')
  process.env.WALLET_LOG_FILE = path.join(dir, 'wallet-log.jsonl')
  process.env.USERS_FILE = path.join(dir, 'users.json')

  const users = await import('../users.js?w=' + Math.random())
  const B = await import('../balance.js?w=' + Math.random())

  const owner = await users.createUser({ email: `own-${Date.now()}@t.io`, name: 'Владелец', password: 'x12345' })
  const sub = await users.createUser({ email: `sub-${Date.now()}@t.io`, name: 'Сотрудник', password: 'x12345', parentId: owner.id })

  await B.changeUsd(100, 'Пополнение из админ-панели', owner.id)
  await B.changeCoins(20, 'Начисление монет', owner.id)
  await B.changeCoins(-3, 'mailing: 60 действ.', sub.id) // тратит СОТРУДНИК, кошелёк общий

  const seen = await B.walletHistory({ userId: sub.id })
  assert.equal(seen.length, 3, 'сотруднику видны все операции общего кошелька')
  assert.equal(seen[0].reason, 'mailing: 60 действ.', 'его собственное списание — сверху')
  assert.equal(seen[2].reason, 'Пополнение из админ-панели', 'и пополнение, сделанное владельцу')

  const balance = await B.getBalance(sub.id)
  assert.equal(balance.usd, 100, 'и баланс тот же самый — это один кошелёк')

  await fs.rm(dir, { recursive: true, force: true })
})
