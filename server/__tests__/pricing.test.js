/**
 * §5.1: бесплатных модулей в системе быть не должно. Раньше платили только четыре
 * из четырнадцати (те, что жгут токены ИИ), а реакции, масслукинг, автопостинг,
 * прогрев, AIR и парсеры работали даром — в том числе при нулевом балансе.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_PRICE, actionPrice, estimateCost, subscriptionCost, modulePrice, MODULE_MONTH_PRICE, SETUPS } from '../pricing.js'
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

/**
 * Цены мельче копейки должны считаться точно. Поймано на живом прогоне: 10 строк
 * парсера списали 0.10 вместо 0.05 — округление до сотых удваивало ставку 0.005.
 */
test('мелкие цены не округляются вверх', () => {
  assert.equal(estimateCost('parsing-groups', 1), 0.005, 'одна строка не должна стоить копейку')
  assert.equal(estimateCost('parsing-groups', 10), 0.05)
  assert.equal(estimateCost('parsing-groups', 3), 0.015)
})


/**
 * §5.4: сумма подписки — то, что клиент реально платит в кабинете. Скидку даёт только
 * ПОЛНОЕ совпадение с сетапом: иначе «почти сетап» получал бы цену сетапа, и поштучная
 * покупка теряла смысл.
 */
test('поштучный набор — сумма без скидки', () => {
  const c = subscriptionCost(['neuro-chatting', 'mailing'])
  assert.equal(c.full, modulePrice('neuro-chatting') + modulePrice('mailing'))
  assert.equal(c.sum, c.full)
  assert.equal(c.setup, null)
  assert.equal(c.discount, 0)
})

test('полный сетап — скидка применяется', () => {
  const outreach = SETUPS.find((s) => s.id === 'setup-outreach')
  const c = subscriptionCost(outreach.modules)
  assert.equal(c.setup, 'setup-outreach')
  assert.equal(c.discount, outreach.discount)
  assert.ok(c.sum < c.full, 'со скидкой дешевле поштучного')
  assert.equal(c.sum, Math.round(c.full * (1 - outreach.discount) * 100) / 100)
})

test('неполный сетап скидки НЕ даёт', () => {
  const outreach = SETUPS.find((s) => s.id === 'setup-outreach')
  const c = subscriptionCost(outreach.modules.slice(0, -1)) // на один модуль меньше
  assert.equal(c.setup, null, 'не хватает одного модуля — не сетап')
  assert.equal(c.discount, 0)
})

test('«всё включено» выгоднее любого частичного набора той же ширины', () => {
  const all = subscriptionCost(Object.keys(MODULE_MONTH_PRICE))
  assert.equal(all.setup, 'setup-all')
  assert.equal(all.discount, 0.35)
})

test('мусор и дубли в наборе игнорируются', () => {
  const c = subscriptionCost(['mailing', 'mailing', 'модуля-нет', ''])
  assert.equal(c.full, modulePrice('mailing'), 'один мейлинг, а не два')
})

test('пустой набор стоит 0', () => {
  assert.deepEqual(subscriptionCost([]), { sum: 0, full: 0, setup: null, discount: 0 })
})

/**
 * Формат монет — тот же, что показывает интерфейс. Держим проверку рядом с прайсом:
 * ставки тысячные, и «0.004» не должно превращаться в «0.00», а «0.07» — в «0.070»
 * (последнее ловилось не сразу: 0.07 * 100 в плавающей точке = 7.000000000000001).
 */
const fmtCoins = (n) => {
  const v = Number(n) || 0
  const milli = Math.round(v * 1000)
  return milli % 10 === 0 ? (milli / 1000).toFixed(2) : (milli / 1000).toFixed(3)
}

test('формат монет: тысячные видны, лишний ноль не появляется', () => {
  assert.equal(fmtCoins(0.005), '0.005', 'цена строки парсера видна целиком')
  assert.equal(fmtCoins(0.004), '0.004', 'а не «0.00 — ничего не потратил»')
  assert.equal(fmtCoins(0.07), '0.07', 'без хвостового нуля от плавающей точки')
  assert.equal(fmtCoins(0.15), '0.15')
  assert.equal(fmtCoins(0.22), '0.22')
  assert.equal(fmtCoins(79.4), '79.40', 'обычные суммы — привычные два знака')
  assert.equal(fmtCoins(0), '0.00')
})

/**
 * §10.1: сумма, которая пишется в базу оплат, обязана учитывать период.
 * Merge оставил баг: годовую подписку за ~$192 писали как месячные $20 —
 * журнал платежей и вкладка «Покупки» недосчитывали выручку с годовых планов.
 */
test('periodCost: год со скидкой, месяц без', async () => {
  const { periodCost, ANNUAL_DISCOUNT, subscriptionCost } = await import('../pricing.js')
  const monthly = subscriptionCost(['neuro-chatting', 'mailing']).sum // 40
  assert.equal(periodCost(monthly, 1), monthly, 'месяц — месячная цена')
  assert.equal(periodCost(monthly, 12), Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT) * 100) / 100, 'год = 12 мес − скидка')
  assert.ok(periodCost(monthly, 12) > monthly, 'год дороже месяца')
  assert.ok(periodCost(monthly, 12) < monthly * 12, 'но дешевле 12 месяцев без скидки')
  // Граница: меньше 12 месяцев скидки не даёт.
  assert.equal(periodCost(20, 6), 120, '6 месяцев — без годовой скидки')
  assert.equal(periodCost(20, 0), 20, 'ноль/пусто → как месяц')
})
