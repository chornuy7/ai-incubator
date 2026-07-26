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

/**
 * Подписка — на всё пространство, монеты — у каждого свои. Пока подписку хранили
 * пер-юзерно, у сотрудника не было своей записи, он получал 'all' и запускал все
 * 14 модулей при двух оплаченных.
 */
test('подписка общая на пространство, а монеты — личные', async () => {
  const B = await fresh()
  await B.setModules(['mailing'], 'usr_owner')
  await B.changeCoins(10, 'пополнение', 'usr_owner')

  assert.deepEqual((await B.getBalance('usr_owner')).modules, ['mailing'])
  assert.deepEqual((await B.getBalance('usr_worker')).modules, ['mailing'], 'сотрудник работает внутри купленного владельцем')
  assert.equal((await B.getBalance('usr_worker')).coins, 0, 'а монеты у него свои')
  assert.equal((await B.getBalance('usr_owner')).coins, 10)

  // Смена набора владельцем видна сотруднику сразу — запись одна.
  await B.setModules(['neuro-chatting'], 'usr_owner')
  assert.deepEqual((await B.getBalance('usr_worker')).modules, ['neuro-chatting'])
})

test('дубли в выборе схлопываются', async () => {
  const B = await fresh()
  await B.setModules(['mailing', 'mailing', 'warming'], 'usr_c')
  assert.deepEqual((await B.getBalance('usr_c')).modules, ['mailing', 'warming'])
})

/**
 * §5.3: сумма монет по всем кошелькам — для админ-панели. После пер-юзерного
 * рефактора getBalance() без id возвращал пустой __default, и статистика
 * показывала ноль вместо реальной суммы.
 */
test('totalCoins: сумма по всем пользователям, служебные ключи не в счёт', async () => {
  const B = await fresh()
  await B.changeCoins(10, 'x', 'usr_a')
  await B.changeCoins(5.5, 'x', 'usr_b')
  await B.setModules(['mailing'], 'usr_a') // пишет __subscription — не должен попасть в сумму
  await B.changeCoins(1, 'x') // __default — в сумму монет идёт, но не считается кошельком

  const t = await B.totalCoins()
  // Служебный кошелёк идёт ОТДЕЛЬНЫМ полем: попадая в общую сумму, он разводил
  // «Монет в системе» с итогом «На счету» в таблице людей — две цифры про одно.
  assert.equal(t.coins, 15.5, 'только людские кошельки: 10 + 5.5')
  assert.equal(t.wallets, 2, 'usr_a и usr_b')
  assert.equal(t.service, 1, 'служебный __default виден, но не смешан с людьми')
})

/**
 * Личная покупка клиента перекрывает общий набор — но только для него.
 * «Тестовий акаунт зайшов, вибрав пакет» — остальное пространство не задето.
 */
test('свой набор перекрывает общий, соседи не задеты', async () => {
  const B = await fresh()
  await B.setModules(['mailing'], 'usr_owner') // общий набор пространства
  await B.setUserModules(['neuro-chatting'], 'usr_client') // клиент купил своё

  assert.deepEqual((await B.getBalance('usr_client')).modules, ['neuro-chatting'], 'клиент видит купленное лично')
  assert.deepEqual((await B.getBalance('usr_worker')).modules, ['mailing'], 'без личной покупки — общий набор')
  assert.deepEqual((await B.getBalance('usr_owner')).modules, ['mailing'], 'владелец не задет чужой покупкой')

  // Смена общего набора не трогает личный.
  await B.setModules(['warming'], 'usr_owner')
  assert.deepEqual((await B.getBalance('usr_client')).modules, ['neuro-chatting'])
  assert.deepEqual((await B.getBalance('usr_worker')).modules, ['warming'])
})
