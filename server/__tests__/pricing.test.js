/**
 * §5.1: бесплатных модулей в системе быть не должно. Раньше платили только четыре
 * из четырнадцати (те, что жгут токены ИИ), а реакции, масслукинг, автопостинг,
 * прогрев, AIR и парсеры работали даром — в том числе при нулевом балансе.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_PRICE, actionPrice, estimateCost } from '../pricing.js'
import { MODULE_DEFS } from '../modules/registry.js'

test('цена проставлена каждому модулю системы и она больше нуля', () => {
  for (const key of Object.keys(MODULE_DEFS)) {
    assert.ok(key in ACTION_PRICE, `нет цены для модуля ${key}`)
    assert.ok(actionPrice(key) > 0, `модуль ${key} бесплатный`)
  }
})

test('неизвестный модуль стоит 0 — новый не должен молча списывать по чужой ставке', () => {
  assert.equal(actionPrice('модуль-которого-нет'), 0)
  assert.equal(actionPrice(undefined), 0)
})

test('оценка запуска: цена × количество, до сотых', () => {
  assert.equal(estimateCost('neuro-commenting', 100), 5)
  assert.equal(estimateCost('mass-react', 250), 2.5)
  assert.equal(estimateCost('parsing-groups', 1000), 5)
  assert.equal(estimateCost('neuro-commenting', 0), 0)
  assert.equal(estimateCost('neuro-commenting', -5), 0, 'отрицательное количество не возвращает деньги')
})

test('сбор данных дешевле боевого действия — иначе парсинг никто не запустит', () => {
  assert.ok(actionPrice('parsing-groups') < actionPrice('neuro-commenting'))
  assert.ok(actionPrice('warming') < actionPrice('mailing'), 'прогрев готовит свои же аккаунты, а не продвигает клиента')
})
