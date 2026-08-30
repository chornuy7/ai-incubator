/**
 * MR-225: владелец ВЫДАЁТ сотруднику токены, а не ставит ему лимит.
 *
 * Заказчик 30.08: «У меня есть пять таких Маш, каждой поставил лимит по 100. Это же 500
 * влезает, а у меня как у владельца может быть всего 100 токенов». Старый «индивидуальный
 * лимит» ничего не выделял: сотрудник тратил из кошелька владельца, а лимит показывался
 * ему как баланс — и сумма лимитов ничем не ограничивалась.
 *
 * Плюс дополнение владельца в чате: «нужно изъять токены добавить возможность».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'mr225-'))
process.env.BALANCE_FILE = path.join(каталог, 'balance.json')
process.env.USERS_FILE = path.join(каталог, 'users.json')
process.env.WALLET_LOG_FILE = path.join(каталог, 'wallet.jsonl')

const { transferCoins, changeCoins, getBalance } = await import('../balance.js')
const { createUser } = await import('../users.js')

const владелец = await createUser({ email: 'owner-mr225@t.io', name: 'Владелец', password: 'secret123' })
const сотрудник = await createUser({ email: 'sub-mr225@t.io', name: 'Маша', password: 'secret123', parentId: владелец.id })

test('выдача уменьшает баланс владельца и появляется у сотрудника', async () => {
  await changeCoins(100, 'тестовое пополнение', владелец.id, 'test')
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: 40 })
  assert.equal(итог.moved, 40)
  assert.equal(итог.ownerLeft, 60, 'у владельца стало меньше ровно на выданное')
  assert.equal(итог.subLeft, 40, 'у сотрудника появилось')
  // Своя запись кошелька у сотрудника появляется только вместе с выдачей: до неё он
  // тратил из кошелька владельца, и начисление вернулось бы владельцу же.
  const { coins } = await getBalance(сотрудник.id)
  assert.equal(coins, 40)
})

test('нельзя выдать больше, чем есть у владельца', async () => {
  await assert.rejects(
    () => transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: 1000 }),
    /выдать 1000 нельзя|У вас/,
    'сумма выданного ограничена остатком владельца — это и была главная беда старой модели',
  )
})

test('изъятие возвращает токены владельцу', async () => {
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: -15 })
  assert.equal(итог.moved, 15)
  assert.equal(итог.subLeft, 25)
  assert.equal(итог.ownerLeft, 75, 'токены вернулись, а не сгорели')
})

test('изымаем больше, чем осталось — забираем остаток и говорим об этом', async () => {
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: -1000 })
  assert.equal(итог.moved, 25, 'забрали ровно остаток')
  assert.equal(итог.subLeft, 0)
  assert.equal(итог.partial, true, 'флаг «забрали не всё, что просили» — чтобы сказать это человеку')
})

test('чужому сотруднику перевести нельзя', async () => {
  const чужой = await createUser({ email: 'alien-mr225@t.io', name: 'Чужой', password: 'secret123' })
  await assert.rejects(
    () => transferCoins({ ownerId: владелец.id, subId: чужой.id, amount: 10 }),
    /не ваш сотрудник/,
  )
  await assert.rejects(() => transferCoins({ ownerId: владелец.id, subId: владелец.id, amount: 10 }), /самому себе/)
})
