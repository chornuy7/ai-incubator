/**
 * MR-149 (созвон 19.08): готовые сетапы — из БД, не из кода. Здесь проверяем, что
 * subscriptionCost считает скидку по ПЕРЕДАННОМУ набору сетапов (на проде — из БД),
 * а не по зашитой константе: иначе витрина и списание разъедутся.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionCost, addedCost } from '../pricing.js'
import { listSetups, upsertSetup, deleteSetup } from '../setups.js'

// Реальные ключи модулей (subscriptionCost фильтрует состав по глобальному MODULE_MONTH_PRICE).
// Цены задаём явным priceMap, чтобы расчёт был предсказуем независимо от прайса по умолчанию.
const price = { mailing: 10, warming: 10, autoposting: 10 }

test('файловый режим: listSetups отдаёт код-дефолт (3 встроенных сетапа)', async () => {
  const s = await listSetups()
  assert.ok(Array.isArray(s) && s.length >= 3)
  assert.ok(s.find((x) => x.id === 'setup-outreach'))
})

test('редактирование сетапов доступно только на БД (в файловом режиме — ошибка)', async () => {
  await assert.rejects(() => upsertSetup({ name: 'X', modules: ['mailing', 'warming'] }), /только на БД/)
  await assert.rejects(() => deleteSetup('setup-all'), /только на БД/)
})

test('subscriptionCost применяет скидку из ПЕРЕДАННОГО сетапа, а не из константы', () => {
  const custom = [{ id: 's1', name: 'Пара', modules: ['mailing', 'warming'], discount: 0.5 }]
  // full = 20, скидка 50% → 10
  const r = subscriptionCost(['mailing', 'warming'], [], price, {}, custom)
  assert.equal(r.full, 20)
  assert.equal(r.sum, 10)
  assert.equal(r.setup, 's1')
  assert.equal(r.discount, 0.5)
})

test('subscriptionCost без сетапов (пустой список) — цена без скидки', () => {
  const r = subscriptionCost(['mailing', 'warming'], [], price, {}, [])
  assert.equal(r.sum, 20, 'нет подходящего сетапа — полная сумма')
  assert.equal(r.setup, null)
})

test('сетап применяется только при ТОЧНОМ совпадении состава (не для подмножества)', () => {
  const custom = [{ id: 's1', name: 'Трио', modules: ['mailing', 'warming', 'autoposting'], discount: 0.3 }]
  // выбрали только mailing+warming — сетап на трио НЕ должен сработать
  const partial = subscriptionCost(['mailing', 'warming'], [], price, {}, custom)
  assert.equal(partial.setup, null)
  assert.equal(partial.sum, 20)
  // выбрали все три — сработал: 30 * 0.7 = 21
  const full = subscriptionCost(['mailing', 'warming', 'autoposting'], [], price, {}, custom)
  assert.equal(full.setup, 's1')
  assert.equal(full.sum, 21)
})

test('addedCost прокидывает сетапы в расчёт добавленного', () => {
  const custom = [{ id: 's1', name: 'Пара', modules: ['mailing', 'warming'], discount: 0.5 }]
  // было пусто, хотим mailing+warming → добавлено оба, цена со скидкой сетапа
  const r = addedCost([], ['mailing', 'warming'], [], price, custom)
  assert.deepEqual(r.added.sort(), ['mailing', 'warming'])
  assert.equal(r.monthly, 10)
})
