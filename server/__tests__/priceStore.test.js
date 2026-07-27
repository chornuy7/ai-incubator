/**
 * §10.4: цены из данных, не из кода. Пустой стор = коды-дефолты (иначе поменялось
 * бы поведение всей витрины). Правка пишет только отличие от дефолта, возврат к
 * дефолту — стирает override.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { MODULE_MONTH_PRICE, subscriptionCost } from '../pricing.js'

async function fresh() {
  const f = path.join(os.tmpdir(), `prices-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  process.env.PRICES_FILE = f
  await fs.rm(f, { force: true })
  return { S: await import('../priceStore.js?p=' + Math.random()), f }
}

test('пустой стор = коды-дефолты', async () => {
  const { S, f } = await fresh()
  const eff = await S.effectivePrices()
  assert.equal(eff.monthMap.mailing, MODULE_MONTH_PRICE.mailing, 'цена как в коде')
  assert.equal(eff.modules.find((m) => m.key === 'mailing').overridden.month, false)
  await fs.rm(f, { force: true })
})

test('правка цены módуля отражается и в карте, и в overridden', async () => {
  const { S, f } = await fresh()
  await S.setOverrides({ modules: { mailing: { month: 25 } } })
  const eff = await S.effectivePrices()
  assert.equal(eff.monthMap.mailing, 25)
  assert.equal(eff.modules.find((m) => m.key === 'mailing').overridden.month, true)
  // subscriptionCost с этой картой должен дать новую сумму
  assert.equal(subscriptionCost(['mailing'], [], eff.monthMap).full, 25)
  await fs.rm(f, { force: true })
})

test('возврат к дефолту стирает override', async () => {
  const { S, f } = await fresh()
  await S.setOverrides({ modules: { mailing: { month: 25 } } })
  await S.setOverrides({ modules: { mailing: { month: MODULE_MONTH_PRICE.mailing } } })
  const eff = await S.effectivePrices()
  assert.equal(eff.modules.find((m) => m.key === 'mailing').overridden.month, false, 'override исчез')
  const raw = await S.getOverrides()
  assert.ok(!raw.modules?.mailing, 'в сторе не осталось мусора')
  await fs.rm(f, { force: true })
})

test('неизвестный модуль и мусорные значения не пишутся', async () => {
  const { S, f } = await fresh()
  await S.setOverrides({ modules: { 'нет-такого': { month: 99 }, mailing: { month: -5 } } })
  const raw = await S.getOverrides()
  assert.ok(!raw.modules?.['нет-такого'], 'левый ключ отброшен')
  assert.ok(!raw.modules?.mailing?.month, 'отрицательная цена отброшена')
  await fs.rm(f, { force: true })
})

test('новые из звонка: tokenUsd по умолчанию не задан, картинка ×4', async () => {
  const { S, f } = await fresh()
  let eff = await S.effectivePrices()
  assert.equal(eff.tokenUsd, null, 'курс токена ждёт числа от Николая')
  assert.equal(eff.imageMultiplier, 4)
  await S.setOverrides({ tokenUsd: 0.00009, imageMultiplier: 5 })
  eff = await S.effectivePrices()
  assert.equal(eff.tokenUsd, 0.00009)
  assert.equal(eff.imageMultiplier, 5)
  await fs.rm(f, { force: true })
})
