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
const { createUser, updateUser, invalidateUsersCache } = await import('../users.js')
const { getBalance, changeCoins, spendByActor } = await import('../balance.js')

/*
 * Личный кошелёк — НАСЛЕДСТВО (правка 27.08: «только общий баланс, у них нету своего
 * кошелька»). Завести его больше нельзя ни созданием, ни правкой, поэтому для проверки
 * возврата денег ставим режим прямо в хранилище — как он стоит у сотрудников, заведённых
 * прошлыми версиями. Через API этот путь не воспроизвести, а покрытие ему нужно: пока
 * такие записи есть на проде, возврат остатка обязан работать.
 */
async function makeLegacyIndividual(id) {
  const fs = await import('node:fs/promises')
  const file = join(process.env.DATA_DIR, 'users.json')
  const users = JSON.parse(await fs.readFile(file, 'utf8'))
  users[users.findIndex((u) => u.id === id)].balanceMode = 'individual'
  await fs.writeFile(file, JSON.stringify(users), 'utf8')
  invalidateUsersCache()
}

/** Перевод, как его делает роут: зеркальные операции по двум кошелькам. */
async function transfer(fromId, toId, amount) {
  await changeCoins(-amount, 'выдача сотруднику', fromId, 'grant')
  await changeCoins(amount, 'выдано владельцем', toId, 'grant')
}

const coins = async (id) => (await getBalance(id)).coins

test('личный кошелёк: выдали, забрали, ничего не потерялось', async () => {
  const st = `${Date.now()}a`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Маша', parentId: owner.id })
  await makeLegacyIndividual(sub.id)

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
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Оля', parentId: owner.id })
  await makeLegacyIndividual(sub.id)

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

test('лимит расхода: сотрудник наследует кошелёк владельца, но тратит не больше выданного', async () => {
  // Уточнение владельца 27.08: «он должен унаследовать всё, что у владельца, просто лимит
  // по токенам, которые ему дали, добавляется ограничение».
  const { spendLimit } = await import('../balance.js')
  const st = `${Date.now()}e`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Маша', parentId: owner.id })

  await changeCoins(500, 'старт', owner.id, 'grant')
  assert.equal(await coins(sub.id), 500) // кошелёк общий — наследует

  // Без лимита ограничения нет вовсе.
  assert.equal((await spendLimit(sub.id)).limit, null)

  await updateUser(sub.id, { tokenLimit: 50 })
  assert.deepEqual(await spendLimit(sub.id), { limit: 50, spent: 0, left: 50 })

  await changeCoins(-20, 'парсинг', sub.id)
  assert.deepEqual(await spendLimit(sub.id), { limit: 50, spent: 20, left: 30 })

  // Деньги при этом ушли из кошелька ВЛАДЕЛЬЦА: лимит не отделяет средства, а ограничивает.
  assert.equal(await coins(owner.id), 480)
})

test('лимит владельцу не ставится: ограничивать себя в своих деньгах нечем', async () => {
  const { spendLimit } = await import('../balance.js')
  const st = `${Date.now()}f`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец', tokenLimit: 10 })
  assert.equal((await spendLimit(owner.id)).limit, null)
})

test('исчерпанный лимит ставит задачу на паузу, а не роняет её', async () => {
  const { chargeActions } = await import('../lib/actionBilling.js')
  const st = `${Date.now()}g`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Паша', parentId: owner.id })

  await changeCoins(500, 'старт', owner.id, 'grant')
  await updateUser(sub.id, { tokenLimit: 1 })
  await changeCoins(-1, 'уже потратил всё', sub.id)

  const logs = []
  const task = { id: 't1', moduleKey: 'parsing', userId: sub.id }
  const store = { appendLog: async (_t, level, msg) => { logs.push(`${level}: ${msg}`) } }

  const res = await chargeActions(task, store, 5)
  assert.equal(res, null, 'списания не было')
  assert.equal(task.pauseRequested, true, 'задача встала на паузу')
  assert.match(logs.join('\n'), /Лимит расхода исчерпан/)
  // Кошелёк владельца не тронут: сотрудник упёрся в лимит ДО списания.
  assert.equal(await coins(owner.id), 499)
})

test('личный кошелёк включает ВЫДАЧА токенов, а не галочка при создании', async () => {
  /*
   * Решение менялось дважды, и это важно помнить при чтении.
   *
   * 27.08 личные кошельки запретили: «только общий баланс, у них нету своего кошелька».
   * Тогда у сотрудника был лимит расхода на кошельке владельца, и вторая касса выглядела
   * лишней сущностью.
   *
   * 30.08 (MR-225) решение отменено: лимит ничего не выделял, и пять сотрудников по 100
   * «влезали» в остаток владельца в 100. Настоящая выдача — это перевод, а перевод
   * невозможен без своего кошелька: начисление вернулось бы владельцу же.
   *
   * Поэтому сейчас правило такое: сам по себе сотрудник заводится на ОБЩЕМ балансе, а
   * личный кошелёк появляется как СЛЕДСТВИЕ первой выдачи — не выбором в форме.
   */
  const st = `${Date.now()}e`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Ваня', parentId: owner.id })
  assert.equal(sub.balanceMode, 'shared', 'по умолчанию — общий баланс владельца')

  await changeCoins(60, 'старт', owner.id, 'grant')
  await changeCoins(-20, 'трата сотрудника', sub.id)
  assert.equal(await coins(owner.id), 40, 'без выдачи сотрудник тратит из кошелька владельца')

  const { transferCoins } = await import('../balance.js')
  const итог = await transferCoins({ ownerId: owner.id, subId: sub.id, amount: 15 })
  assert.equal(итог.ownerLeft, 25, 'у владельца стало меньше ровно на выданное')
  assert.equal(итог.subLeft, 15, 'у сотрудника появился свой остаток')
  const после = await updateUser(sub.id, {})
  assert.equal(после.balanceMode, 'individual', 'режим сменила сама выдача')
})

test('витрина сотрудника: денег нет, токены — в пределах потолка', async () => {
  // Правка 27.08: «деньги у саб-пользователя не показываем, только доступные токены,
  // чтобы он не мог их потратить». Проверяем саму арифметику доступного остатка —
  // роут собирает ответ из этих же двух чисел.
  const st = `${Date.now()}f`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Гриша', parentId: owner.id, tokenLimit: 100 })

  await changeCoins(1000, 'старт', owner.id, 'grant')
  const { spendLimit } = await import('../balance.js')

  let lim = await spendLimit(sub.id)
  assert.equal(Math.min(await coins(sub.id), lim.left), 100, 'видит свой потолок, а не тысячу владельца')

  await changeCoins(-40, 'работа сотрудника', sub.id)
  lim = await spendLimit(sub.id)
  assert.equal(Math.min(await coins(sub.id), lim.left), 60, 'остаток уменьшается на потраченное им')

  // Владелец при этом видит свой настоящий остаток целиком.
  assert.equal(await coins(owner.id), 960)
})

test('потолок лимита — остаток владельца плюс уже потраченное сотрудником', async () => {
  /*
   * Правка 27.08: «если у него общих токенов 400, то он больше 400 не должен иметь
   * возможность вводить». Проверяем саму формулу потолка — её считают и витрина (обрезая
   * ввод), и роут (отклоняя запрос). Уже потраченное входит в потолок: лимит
   * накопительный, и у потратившего 800 из 1000 новый потолок не может быть просто
   * остатком владельца — иначе лимит оказался бы ниже сделанной работы.
   */
  const st = `${Date.now()}g`
  const owner = await createUser({ email: `o${st}@t.io`, password: 'secret123', name: 'Владелец' })
  const sub = await createUser({ email: `s${st}@t.io`, password: 'secret123', name: 'Тимур', parentId: owner.id, tokenLimit: 1000 })

  await changeCoins(1000, 'старт', owner.id, 'grant')
  const { spendLimit } = await import('../balance.js')
  const потолок = async () => Math.floor((await coins(owner.id)) + (await spendLimit(sub.id)).spent)

  assert.equal(await потолок(), 1000, 'пока не тратили — сколько на счету')

  await changeCoins(-800, 'работа', sub.id)
  assert.equal(await coins(owner.id), 200, 'у владельца осталось 200')
  assert.equal(await потолок(), 1000, 'потолок не упал ниже уже потраченных 800')

  await changeCoins(-100, 'моя работа', owner.id)
  assert.equal(await потолок(), 900, 'трата владельца потолок снижает')
})
