/**
 * §5.3: счёт клиенту. Монеты складываются из ДВУХ статей — плата за действия
 * (фикс по прайсу) и плата за токены ИИ. Раньше в отчёт шли только токены, и
 * парсер на сотню действий показывал ноль монет: клиенту предъявляли меньше,
 * чем с него на самом деле списали.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { clientReport, adminOverview } from '../adminStats.js'

test('clientReport: монеты за действия попадают в счёт, а не только за токены', async () => {
  const rep = await clientReport({ since: 0 })
  assert.ok(Array.isArray(rep.rows), 'есть строки')

  for (const r of rep.rows) {
    assert.equal(typeof r.actionCoins, 'number', `${r.moduleKey}: есть монеты за действия`)
    assert.equal(typeof r.tokenCoins, 'number', `${r.moduleKey}: есть монеты за ИИ`)
    assert.equal(
      Math.round(r.coins * 1000) / 1000,
      Math.round((r.actionCoins + r.tokenCoins) * 1000) / 1000,
      `${r.moduleKey}: итог строки = действия + ИИ`,
    )
  }

  assert.equal(typeof rep.totals.actionCoins, 'number', 'итоги тоже разбиты по статьям')
  assert.equal(
    Math.round(rep.totals.coins * 1000) / 1000,
    Math.round((rep.totals.actionCoins + rep.totals.tokenCoins) * 1000) / 1000,
    'итог по всем модулям сходится',
  )
})

test('clientReport: строки отсортированы по действиям — самое весомое сверху', async () => {
  const rep = await clientReport({ since: 0 })
  const acts = rep.rows.map((r) => r.actions)
  assert.deepEqual(acts, [...acts].sort((a, b) => b - a), 'по убыванию действий')
})

test('adminOverview: «монет в системе» — сумма по кошелькам, а не пустой служебный', async () => {
  const o = await adminOverview({})
  assert.ok(o.coinTotal, 'поле есть')
  assert.equal(typeof o.coinTotal.coins, 'number')
  assert.equal(typeof o.coinTotal.wallets, 'number')
  assert.ok(o.coinTotal.coins >= 0, 'не отрицательное')
})
