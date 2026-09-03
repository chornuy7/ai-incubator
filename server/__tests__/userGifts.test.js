/**
 * MR-189: подарочные ⚡ выдаются ОДИН раз за модуль.
 *
 * Созвон 24.08: «подарочные — они один раз только добавляются, и всё, это единоразовое
 * добавление». При разборе выяснилось хуже: подарок вообще не начислялся — считался в
 * стоимости набора и показывался на витрине, но ни одна точка начисления его не выдавала.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const GIFTS = { 'neuro-commenting': 200, 'neuro-chatting': 100, warming: 0 }

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gifts-'))
  process.env.USER_GIFTS_FILE = path.join(dir, 'user-gifts.json')
  return import(`../userGifts.js?t=${Date.now()}${Math.round(performance.now())}`)
}

test('первая покупка модуля даёт подарок', async () => {
  const g = await freshStore()
  const due = await g.pendingGift('usr_1', ['neuro-commenting'], GIFTS)
  assert.deepEqual(due, { coins: 200, modules: ['neuro-commenting'] })
})

test('повторная покупка того же модуля подарок НЕ даёт', async () => {
  const g = await freshStore()
  await g.markGifted('usr_1', ['neuro-commenting'], GIFTS)
  const due = await g.pendingGift('usr_1', ['neuro-commenting'], GIFTS)
  assert.deepEqual(due, { coins: 0, modules: [] }, 'вернул модуль в подписку — второго подарка нет')
})

test('подарок считается только за НОВЫЕ модули', async () => {
  const g = await freshStore()
  await g.markGifted('usr_1', ['neuro-commenting'], GIFTS)
  const due = await g.pendingGift('usr_1', ['neuro-commenting', 'neuro-chatting'], GIFTS)
  assert.deepEqual(due, { coins: 100, modules: ['neuro-chatting'] })
})

test('подарок одного человека не влияет на другого', async () => {
  const g = await freshStore()
  await g.markGifted('usr_1', ['neuro-commenting'], GIFTS)
  const due = await g.pendingGift('usr_2', ['neuro-commenting'], GIFTS)
  assert.equal(due.coins, 200, 'второму человеку подарок всё ещё полагается')
})

test('модуль без подарка ничего не начисляет', async () => {
  const g = await freshStore()
  const due = await g.pendingGift('usr_1', ['warming'], GIFTS)
  assert.deepEqual(due, { coins: 0, modules: [] })
})

test('повторная отметка выдачи ничего не ломает и не задваивает', async () => {
  const g = await freshStore()
  await g.markGifted('usr_1', ['neuro-commenting'], GIFTS)
  await g.markGifted('usr_1', ['neuro-commenting'], GIFTS)
  assert.equal((await g.pendingGift('usr_1', ['neuro-commenting'], GIFTS)).coins, 0)
})

test('без пользователя или модулей не считаем и не пишем', async () => {
  const g = await freshStore()
  assert.equal((await g.pendingGift('', ['neuro-commenting'], GIFTS)).coins, 0)
  assert.equal((await g.pendingGift('usr_1', [], GIFTS)).coins, 0)
  await g.markGifted('', ['neuro-commenting'], GIFTS) // не должно упасть
})

/*
 * Ежедневная сверка (правка 27.08). Разбор живого случая: на витрине владельцу обещано
 * «500 ⚡ в месяц + 311 ⚡ разово», на счету 400 — подарки не были начислены НИ ОДНОМУ
 * человеку, таблица выдач пустая. Выдача существовала в одной точке — в момент оплаты, —
 * и если там не сработало (кода ещё нет, миграция не накатана, запрос упал), второго
 * шанса не было никогда. Сверка догоняет пропущенное; главное её свойство — не выдать
 * дважды.
 */
test('сверка догоняет пропущенный подарок и второй раз его не выдаёт', async () => {
  const g = await freshStore()
  const modules = ['neuro-commenting', 'neuro-chatting', 'warming']
  // Первый проход сверки: оплата прошла давно, подарок не выдавался — догоняем.
  const first = await g.pendingGift('usr_1', modules, GIFTS)
  assert.equal(first.coins, 300, 'догнали оба подарочных модуля (200 + 100)')
  await g.markGifted('usr_1', first.modules, GIFTS)

  // Второй проход в тот же день / завтра — платить больше нечего.
  const second = await g.pendingGift('usr_1', modules, GIFTS)
  assert.deepEqual(second, { coins: 0, modules: [] }, 'повторная сверка ничего не начисляет')

  // Докупил модуль без подарка — сверка тоже молчит.
  const third = await g.pendingGift('usr_1', [...modules, 'warming'], GIFTS)
  assert.equal(third.coins, 0)
})

test('сверка без общей БД ничего не делает и не падает', async () => {
  // Файловый режим (дев/тесты): подписки живут в Supabase, сверять нечего.
  const { creditPendingGifts } = await import('../tokenCredit.js')
  assert.deepEqual(await creditPendingGifts(), { users: 0, coins: 0 })
})
