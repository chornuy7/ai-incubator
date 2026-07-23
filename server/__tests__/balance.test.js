/**
 * Кошельки пер-юзерные (§5.1, B2). Проверяем то, ради чего это переделывали:
 * один клиент не тратит монеты другого, и монеты уже начисленные до перехода
 * на пер-юзерное хранение не пропадают при первом же списании.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const tmp = () => path.join(os.tmpdir(), `bal-${process.pid}-${Math.random().toString(36).slice(2)}.json`)

async function fresh() {
  process.env.BALANCE_FILE = tmp()
  await fs.rm(process.env.BALANCE_FILE, { force: true })
  // Импорт один раз на процесс — путь читается функцией, поэтому смена env работает.
  return import('../balance.js')
}

test('баланс раздельный: списание у одного не трогает другого', async () => {
  const B = await fresh()
  await B.changeCoins(100, 'пополнение', 'usr_a')
  await B.changeCoins(5, 'пополнение', 'usr_b')
  await B.changeCoins(-30, 'ИИ', 'usr_a')
  assert.equal((await B.getBalance('usr_a')).coins, 70)
  assert.equal((await B.getBalance('usr_b')).coins, 5)
})

test('в минус не уходим — правило «при нуле модули стоят» иначе непроверяемо', async () => {
  const B = await fresh()
  await B.changeCoins(2, 'пополнение', 'usr_c')
  await B.changeCoins(-50, 'ИИ', 'usr_c')
  assert.equal((await B.getBalance('usr_c')).coins, 0)
  assert.equal(await B.hasCoins(1, 'usr_c'), false)
})

test('тариф тоже свой у каждого', async () => {
  const B = await fresh()
  await B.setPlan('pro', 'usr_a')
  await B.setPlan('none', 'usr_b')
  assert.equal((await B.getBalance('usr_a')).plan.accountLimit, 200)
  assert.equal((await B.getBalance('usr_b')).plan.accountLimit, 3)
})

test('старый общий кошелёк не теряется: читается как баланс по умолчанию', async () => {
  const B = await fresh()
  await fs.writeFile(process.env.BALANCE_FILE, JSON.stringify({ planId: 'pro', coins: 79.93 }), 'utf8')
  assert.equal((await B.getBalance()).coins, 79.93)
  assert.equal((await B.getBalance()).planId, 'pro')
  // После первого списания формат перепишется на пер-юзерный — монеты должны уцелеть.
  await B.changeCoins(-0.93, 'ИИ')
  assert.equal((await B.getBalance()).coins, 79)
  const raw = JSON.parse(await fs.readFile(process.env.BALANCE_FILE, 'utf8'))
  assert.equal(raw.coins, undefined, 'старый корневой формат должен быть вычищен')
  assert.equal(raw[B.DEFAULT_USER].coins, 79)
})

test('запрос без пользователя не забирает монеты у клиента', async () => {
  const B = await fresh()
  await B.changeCoins(10, 'пополнение', 'usr_a')
  await B.changeCoins(-10, 'фоновая задача без владельца')
  assert.equal((await B.getBalance('usr_a')).coins, 10)
  assert.equal((await B.getBalance()).coins, 0)
})

/**
 * Подписка на модули. Заказчик (23.07): «вибирає собі модулі які хоче, сума
 * сумується і оплачується в кабінеті — доступ тільки до них».
 */
test('открыты только оплаченные модули', async () => {
  const B = await fresh()
  await B.setModules(['neuro-chatting', 'mailing'], 'usr_x')
  const { modules } = await B.getBalance('usr_x')
  assert.deepEqual(modules, ['neuro-chatting', 'mailing'])
  assert.equal(B.modulesAllow(modules, 'neuro-chatting'), true)
  assert.equal(B.modulesAllow(modules, 'mailing'), true)
  assert.equal(B.modulesAllow(modules, 'neuro-commenting'), false, 'за него не платили')
})

test('пока набор не выбран — открыто всё: выкатка не должна запирать текущих клиентов', async () => {
  const B = await fresh()
  const { modules } = await B.getBalance('usr_new')
  assert.equal(modules, 'all')
  assert.equal(B.modulesAllow(modules, 'mailing'), true)
})

test('подписка у каждого своя, как и монеты', async () => {
  const B = await fresh()
  await B.setModules(['mailing'], 'usr_a')
  await B.setModules(['neuro-commenting'], 'usr_b')
  assert.deepEqual((await B.getBalance('usr_a')).modules, ['mailing'])
  assert.deepEqual((await B.getBalance('usr_b')).modules, ['neuro-commenting'])
})

test('дубли в выборе схлопываются', async () => {
  const B = await fresh()
  await B.setModules(['mailing', 'mailing', 'warming'], 'usr_c')
  assert.deepEqual((await B.getBalance('usr_c')).modules, ['mailing', 'warming'])
})
