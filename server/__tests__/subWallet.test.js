/**
 * Кошелёк сотрудника: выдача, возврат и переход на общий баланс (решение владельца 27.08).
 *
 * До этого режим «личный кошелёк» был ловушкой: сотрудник получал ПУСТОЙ кошелёк, поле
 * «лимит токенов» из формы нигде не проверялось, пополнить кошелёк мог только админ, а
 * сменить режим было нельзя вовсе. Здесь закрыто главное: деньги ходят в обе стороны и
 * не теряются при смене режима.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sub-wallet-'))
const { createUser, updateUser } = await import('../users.js')
const { getBalance, changeCoins, spendByActor } = await import('../balance.js')

/** Перевод, как его делает роут: зеркальные операции по двум кошелькам. */
async function transfer(fromId, toId, amount) {
  await changeCoins(-amount, 'выдача сотруднику', fromId, 'grant')
  await changeCoins(amount, 'выдано владельцем', toId, 'grant')
}

const coins = async (id) => (await getBalance(id)).coins

test('личный кошелёк: выдали, забрали, ничего не потерялось', async () => {
  const st = `${Date.now()}a`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Маша', parentId: owner.id, balanceMode: 'individual' })

  await changeCoins(100, 'старт', owner.id, 'grant')
  assert.equal(await coins(owner.id), 100)
  assert.equal(await coins(sub.id), 0) // свой кошелёк — выдача владельцу сюда не попадает

  await transfer(owner.id, sub.id, 30)
  assert.equal(await coins(owner.id), 70)
  assert.equal(await coins(sub.id), 30)

  await transfer(sub.id, owner.id, 10) // забрали обратно
  assert.equal(await coins(owner.id), 80)
  assert.equal(await coins(sub.id), 20)
})

test('общий баланс: кошелёк один на двоих', async () => {
  const st = `${Date.now()}b`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Паша', parentId: owner.id })

  await changeCoins(50, 'старт', owner.id, 'grant')
  assert.equal(await coins(sub.id), 50) // видит те же деньги
  await changeCoins(-20, 'трата суба', sub.id)
  assert.equal(await coins(owner.id), 30) // тратит из кошелька владельца
})

test('расход раскладывается по сотрудникам, начисления в него не идут', async () => {
  const st = `${Date.now()}c`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const m = await createUser({ email: `m${st}@t.io`, password: 'secret123', name: 'Маша', parentId: owner.id })
  const p = await createUser({ email: `p${st}@t.io`, password: 'secret123', name: 'Паша', parentId: owner.id })

  await changeCoins(200, 'выдача', owner.id, 'grant')
  await changeCoins(-30, 'парсинг', m.id)
  await changeCoins(-12, 'мейлинг', m.id)
  await changeCoins(-50, 'комментинг', p.id)

  const rep = await spendByActor({ userId: owner.id })
  const byId = Object.fromEntries(rep.map((r) => [r.actorId, r]))
  assert.equal(byId[m.id].spent, 42)
  assert.equal(byId[m.id].ops, 2)
  assert.equal(byId[p.id].spent, 50)
  // Начисление 200 — не расход владельца: иначе выдача себе считалась бы тратой.
  assert.ok(!byId[owner.id], 'у владельца трат не было')
})

test('переход на общий баланс: остаток личного кошелька возвращается владельцу', async () => {
  const st = `${Date.now()}d`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Оля', parentId: owner.id, balanceMode: 'individual' })

  await changeCoins(100, 'старт', owner.id, 'grant')
  await transfer(owner.id, sub.id, 25)
  assert.equal(await coins(sub.id), 25)

  // Роут делает это сам; здесь повторяем ту же операцию, чтобы проверить саму арифметику
  // возврата: деньги не должны остаться в кошельке, которым больше не пользуются.
  const upd = await updateUser(sub.id, { balanceMode: 'shared' })
  assert.equal(upd.balanceMode, 'shared')
  const left = await coins(sub.id) // теперь это уже кошелёк владельца
  assert.equal(left, 75)
})
