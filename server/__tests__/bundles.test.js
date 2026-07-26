/**
 * §5.4: наборы, которые админ собирает под клиента. «Парсер + комментинг за 20 $» —
 * покупатель получает ровно эти модули по ровно этой цене. Это договорённость о
 * деньгах, поэтому и хранение, и расчёт под тестом.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { subscriptionCost } from '../pricing.js'

async function fresh() {
  const dir = path.join(os.tmpdir(), `bundles-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.BUNDLES_FILE = path.join(dir, 'bundles.json')
  const B = await import('../bundles.js?b=' + Math.random())
  return { B, dir }
}

test('создать → увидеть → удалить', async () => {
  const { B, dir } = await fresh()
  const b = await B.createBundle({ name: 'Парсер + Комментинг', modules: ['parsing-groups', 'neuro-commenting'], price: 20 })
  assert.ok(b.id.startsWith('bun_'))
  assert.equal((await B.listBundles()).length, 1)
  assert.equal(await B.deleteBundle(b.id), true)
  assert.equal((await B.listBundles()).length, 0)
  assert.equal(await B.deleteBundle(b.id), false, 'повторное удаление — честное «не найден»')
  await fs.rm(dir, { recursive: true, force: true })
})

test('валидация: воздух не продаём', async () => {
  const { B, dir } = await fresh()
  await assert.rejects(() => B.createBundle({ name: '', modules: ['mailing'], price: 5 }), /имя/)
  await assert.rejects(() => B.createBundle({ name: 'X', modules: [], price: 5 }), /хотя бы один/)
  await assert.rejects(() => B.createBundle({ name: 'X', modules: ['mailing'], price: 0 }), /больше нуля/)
  // Опечатка в ключе продавала бы модуль, который никогда не откроется.
  await assert.rejects(() => B.createBundle({ name: 'X', modules: ['parsing-grups'], price: 5 }), /Неизвестные модули/)
  assert.equal((await B.listBundles()).length, 0, 'ни одна ошибка не оставила мусора')
  await fs.rm(dir, { recursive: true, force: true })
})

test('цена набора действует только на ТОЧНЫЙ состав', () => {
  const bundles = [{ id: 'bun_x', name: 'K', modules: ['parsing-groups', 'neuro-commenting'], price: 20 }]
  const exact = subscriptionCost(['parsing-groups', 'neuro-commenting'], bundles)
  assert.equal(exact.sum, 20, 'точный состав — цена админа')
  assert.equal(exact.setup, 'bun_x')
  assert.equal(exact.full, 28, 'поштучно было бы 28')

  const superset = subscriptionCost(['parsing-groups', 'neuro-commenting', 'mailing'], bundles)
  assert.equal(superset.setup, null, 'добавил модуль — набор больше не действует')
  assert.equal(superset.sum, superset.full, 'платит поштучно')
})

test('набор дороже поштучной суммы не навязывается', () => {
  // Клиент не должен платить за «набор» больше, чем те же модули стоят по прайсу.
  const bundles = [{ id: 'bun_y', name: 'Дорогой', modules: ['parsing-groups'], price: 99 }]
  const c = subscriptionCost(['parsing-groups'], bundles)
  assert.equal(c.sum, 8, 'поштучная цена ниже — берём её')
  assert.equal(c.setup, null)
})

test('встроенные сетапы и наборы админа конкурируют честно — побеждает дешёвый', () => {
  const outreach = ['parsing-users', 'parsing-groups', 'mailing', 'neuro-dialogs', 'neuro-chatting']
  const cheap = [{ id: 'bun_z', name: 'Демпинг', modules: outreach, price: 50 }]
  const c = subscriptionCost(outreach, cheap)
  assert.equal(c.sum, 50, 'набор админа за 50 дешевле сетапа за 64.8')
  assert.equal(c.setup, 'bun_z')

  const pricey = [{ id: 'bun_w', name: 'Дороже сетапа', modules: outreach, price: 70 }]
  const c2 = subscriptionCost(outreach, pricey)
  assert.equal(c2.sum, 64.8, 'сетап со скидкой дешевле — клиент получает его')
  assert.equal(c2.setup, 'setup-outreach')
})
