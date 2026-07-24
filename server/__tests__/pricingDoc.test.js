/**
 * docs/ПРАЙСЫ.md собирается из кода. Тест ловит расхождение: если ставку поменяли,
 * а документ не пересобрали, клиенту назовут одну цену, а спишут другую — ровно та
 * беда, ради которой документ и генерируется, а не пишется руками.
 *
 * Чинится одной командой: npm run gen-pricing
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MODULE_MONTH_PRICE, ACTION_PRICE, SETUPS, subscriptionCost } from '../pricing.js'
import { moduleTitle } from '../lib/moduleTitles.js'

const DOC = new URL('../../docs/ПРАЙСЫ.md', import.meta.url)

test('в документе есть каждый модуль с его ценой подписки', async () => {
  const md = await readFile(DOC, 'utf8')
  for (const [key, price] of Object.entries(MODULE_MONTH_PRICE)) {
    const line = `| ${moduleTitle(key)} | ${price} |`
    assert.ok(md.includes(line), `нет строки «${line}» — пересоберите: npm run gen-pricing`)
  }
})

test('в документе цены наборов совпадают с расчётом', async () => {
  const md = await readFile(DOC, 'utf8')
  for (const s of SETUPS) {
    const cost = subscriptionCost(s.modules)
    assert.ok(md.includes(`**$${cost.sum}**`), `${s.name}: цена ${cost.sum} не найдена в документе`)
  }
})

test('в документе есть ставки за действия', async () => {
  const md = await readFile(DOC, 'utf8')
  const paid = Object.entries(ACTION_PRICE).filter(([k, v]) => v > 0 && MODULE_MONTH_PRICE[k] !== undefined)
  for (const [key, price] of paid) {
    assert.ok(md.includes(`| ${moduleTitle(key)} | ${price} |`), `${key}: ставка ${price} не в документе`)
  }
})
