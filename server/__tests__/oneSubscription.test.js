import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prorataCost, MONTH_DAYS } from '../pricing.js'

/**
 * Решение владельца 21.08: «делаем 1 подписку и туда докупаем уже модули».
 *
 * Отсюда две разные операции, которые до этого были одной:
 *  - ДОКУПКА в действующую подписку — модуль работает до её конца, платим за остаток
 *    дней, дату не двигаем;
 *  - ПРОДЛЕНИЕ — платим за весь набор, дата считается от конца текущей подписки.
 *
 * До правки докупка шла по полной месячной цене И продлевала весь набор: добавил парсер
 * за $8 — продлил подписку за $121.
 */

const DAY = 24 * 60 * 60 * 1000

test('докупка стоит долю месяца по остатку подписки', () => {
  // Мейлинг $20/мес, до конца подписки ровно половина месяца → половина цены.
  assert.equal(prorataCost(20, 15 * DAY), 10)
  // Остался почти весь месяц — почти полная цена.
  assert.equal(prorataCost(20, 30 * DAY), 20)
  // Остаток больше месяца (годовая подписка) — больше месячной цены не берём:
  // это докупка НА ОСТАТОК, а не отдельная продажа на год.
  assert.equal(prorataCost(20, 300 * DAY), 20)
})

test('огрызок последнего дня округляется вверх — ноль в чеке не показываем', () => {
  const cost = prorataCost(30, 2 * 60 * 60 * 1000) // два часа до конца подписки
  assert.ok(cost > 0, 'бесплатной докупки не бывает')
  assert.equal(cost, Math.round((30 / MONTH_DAYS) * 100) / 100, 'ровно один день')
})

test('нулевая цена набора остаётся нулевой', () => {
  assert.equal(prorataCost(0, 10 * DAY), 0)
})

/**
 * Регресс на дыру, из-за которой докупка продлевала всё: `mergeExpiry` брал максимум из
 * старой и новой даты. Теперь дату двигает ТОЛЬКО явная дата продления.
 */
test('докупка не двигает дату подписки, продление двигает', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'))
  process.env.BALANCE_FILE = path.join(dir, 'balance.json')
  const { setUserModules, getBalance } = await import('../balance.js')

  const until = Date.now() + 10 * DAY
  await setUserModules(['parsing'], 'u1', { expiresAt: until })
  const first = await getBalance('u1')
  assert.equal(first.expiresAt, until)

  // Докупка (merge, без явной даты) — набор растёт, дата стоит.
  await setUserModules(['mailing'], 'u1', { mode: 'merge', months: 1 })
  const added = await getBalance('u1')
  assert.deepEqual([...added.modules].sort(), ['mailing', 'parsing'])
  assert.equal(added.expiresAt, until, 'докупка не должна продлевать подписку')

  // Продление — явная дата от конца текущей подписки.
  const renewed = until + 30 * DAY
  await setUserModules(['mailing', 'parsing'], 'u1', { mode: 'merge', expiresAt: renewed })
  assert.equal((await getBalance('u1')).expiresAt, renewed)
})
