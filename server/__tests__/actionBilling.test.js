/**
 * Деньги: списание за действия и остановка задачи на нуле. Проверяем моками кошелька —
 * поднимать реальный запуск в Telegram ради проверки арифметики нельзя.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chargeActions, chargeCollected, refundShrunk } from '../lib/actionBilling.js'

/** Кошелёк-заглушка: в минус не уходит, как настоящий. */
function wallet(start) {
  let coins = start
  return {
    coins: () => coins,
    // Тысячные, как в настоящем кошельке: до сотых ставка 0.005 удваивалась.
    changeCoins: async (delta) => { coins = Math.max(0, Math.round((coins + delta) * 1000) / 1000) },
    getBalance: async () => ({ coins }),
  }
}
const storeMock = () => { const logs = []; return { logs, appendLog: async (_t, level, text) => logs.push({ level, text }) } }

test('списывает по прайсу модуля и не трогает статус, пока монеты есть', async () => {
  const w = wallet(10)
  const task = { moduleKey: 'neuro-commenting', userId: 'u1' }
  const store = storeMock()
  await chargeActions(task, store, 4, w) // 4 × 0.05
  assert.equal(w.coins(), 9.8)
  assert.equal(task.pauseRequested, undefined, 'задача не должна вставать при живом балансе')
  assert.equal(store.logs.length, 0)
})

test('на нуле ставит задачу на ПАУЗУ (не стоп) и пишет причину в логи', async () => {
  const w = wallet(0.05)
  const task = { moduleKey: 'neuro-commenting', userId: 'u1' }
  const store = storeMock()
  await chargeActions(task, store, 1, w)
  assert.equal(w.coins(), 0)
  assert.equal(task.pauseRequested, true, 'иначе начатая задача доработала бы бесплатно')
  assert.notEqual(task.stopRequested, true, 'стоп потерял бы прогресс — за уже сделанное платили бы дважды')
  assert.match(store.logs[0].text, /Закончились монеты/)
  assert.match(store.logs[0].text, /Продолжить/, 'в логе должно быть сказано, что делать дальше')
  // info, а не error: кончившиеся деньги — не поломка модуля. С уровнем error задача
  // попадала разом и в «Задач с ошибками», и в «Встали из-за баланса», а в списке
  // ошибок висела строка «Закончились монеты», которую чинить нечем.
  assert.equal(store.logs[0].level, 'info')
})

test('модуль без цены не списывает ничего', async () => {
  const w = wallet(5)
  await chargeActions({ moduleKey: 'модуля-нет', userId: 'u1' }, storeMock(), 100, w)
  assert.equal(w.coins(), 5)
})

test('парсер платит за НОВЫЕ строки, а не за весь список заново', async () => {
  const w = wallet(10)
  const task = { moduleKey: 'parsing-groups', userId: 'u1', results: [] }
  const store = storeMock()

  task.results = new Array(100).fill(0)
  await chargeCollected(task, store, w)
  assert.equal(w.coins(), 9.5) // 100 × 0.005

  task.results = new Array(300).fill(0)
  await chargeCollected(task, store, w)
  assert.equal(w.coins(), 8.5, 'списываем за 200 новых, а не за все 300')

  await chargeCollected(task, store, w) // ничего не добавилось
  assert.equal(w.coins(), 8.5, 'повторный вызов без новых строк бесплатен')
})

test('сбой кошелька не роняет задачу — действия в Telegram уже совершены', async () => {
  const broken = { changeCoins: async () => { throw new Error('диск отвалился') }, getBalance: async () => ({ coins: 0 }) }
  const task = { moduleKey: 'mailing', userId: 'u1' }
  assert.equal(await chargeActions(task, storeMock(), 1, broken), null)
  assert.equal(task.pauseRequested, undefined)
})

test('парсер: 10 строк стоят 0.05, а не 0.10 (округление до сотых удваивало ставку)', async () => {
  const w = wallet(1)
  const task = { moduleKey: 'parsing-groups', userId: 'u1', results: [] }
  const store = storeMock()
  for (let i = 0; i < 10; i += 1) { task.results.push(i); await chargeCollected(task, store, w) }
  assert.equal(w.coins(), 0.95)
  assert.equal(task.spentCoins, 0.05)
})

test('возврат за строки, которые срезали фильтры', async () => {
  const w = wallet(1)
  const task = { moduleKey: 'parsing-groups', userId: 'u1', results: new Array(53).fill(0) }
  const store = storeMock()
  await chargeCollected(task, store, w)
  assert.equal(w.coins(), 0.735) // 53 × 0.005
  task.results = [] // AND-пересечение убрало всё — живой случай
  await refundShrunk(task, store, w)
  assert.equal(w.coins(), 1, 'за пустой результат платить не за что')
  assert.equal(task.spentCoins, 0)
  assert.match(store.logs.at(-1).text, /Возврат/)
})
