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

test('§10.1: tokenUsd считается сам из модели, картинка ×4', async () => {
  const { S, f } = await fresh()
  let eff = await S.effectivePrices()
  // Больше не null: себестоимость токена выведена из прайса модели (gpt-4o-mini).
  assert.ok(typeof eff.tokenUsd === 'number' && eff.tokenUsd > 0, 'цена токена рассчитана, а не пуста')
  assert.equal(eff.tokenUsdAuto, true, 'по умолчанию — авто-расчёт')
  assert.equal(eff.tokenUsdModel, 'gpt-4o-mini')
  assert.equal(eff.imageMultiplier, 4)
  // Админский override побеждает авто-расчёт и помечает tokenUsdAuto=false.
  await S.setOverrides({ tokenUsd: 0.00009, imageMultiplier: 5 })
  eff = await S.effectivePrices()
  assert.equal(eff.tokenUsd, 0.00009)
  assert.equal(eff.tokenUsdAuto, false, 'после ручной правки — не авто')
  assert.equal(eff.imageMultiplier, 5)
  await fs.rm(f, { force: true })
})

test('§10.1: себестоимость токена — смешанная ставка input/output модели', async () => {
  // MR-149: долю input теперь берём ПО ФАКТУ из журнала расхода, а не из константы 0.75.
  // Для проверки самой формулы журнал изолируем в пустой файл — тогда доля = заданная (0.75).
  const prevLedger = process.env.TOKEN_LEDGER_FILE
  process.env.TOKEN_LEDGER_FILE = path.join(os.tmpdir(), `ledger-empty-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`)
  const { tokenUsdForModel } = await import('../lib/modelPricing.js')
  // gpt-4o-mini: input $0.15/1M, output $0.60/1M, доля input 0.75 →
  // (0.15*0.75 + 0.60*0.25)/1e6 = 0.2625/1e6 = 0.0000002625
  // MR-149: функция стала async — прайс моделей и доля input лежат в БД (в файловом режиме
  // берутся код-константы, поэтому числа те же).
  assert.equal(await tokenUsdForModel('gpt-4o-mini'), 0.0000002625)
  // Датированное имя модели матчится на базовый прайс.
  assert.equal(await tokenUsdForModel('gpt-4o-mini-2024-07-18'), 0.0000002625)
  // gpt-4o дороже мини.
  assert.ok(await tokenUsdForModel('gpt-4o') > await tokenUsdForModel('gpt-4o-mini'))
  // Незнакомая модель — null (админка попросит задать вручную).
  assert.equal(await tokenUsdForModel('unknown-model-x'), null)
  if (prevLedger === undefined) delete process.env.TOKEN_LEDGER_FILE; else process.env.TOKEN_LEDGER_FILE = prevLedger
})

test('годовая скидка редактируется и effectivePrices её отдаёт', async () => {
  const { S, f } = await fresh()
  let eff = await S.effectivePrices()
  assert.equal(eff.annualDiscount, 0.2, 'дефолт из кода')
  await S.setOverrides({ annualDiscount: 0.3 })
  eff = await S.effectivePrices()
  assert.equal(eff.annualDiscount, 0.3, 'правка видна')
  await fs.rm(f, { force: true })
})
