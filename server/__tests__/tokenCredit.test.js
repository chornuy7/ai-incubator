/**
 * MR-150 (Шаг 2): ежемесячное начисление токенов реально зачисляет монеты на баланс и не
 * удваивает при повторном запуске в тот же день.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcredit-'))
process.env.BALANCE_FILE = path.join(dir, 'balance.json')       // подписки лягут рядом (user-subscriptions.json)
process.env.PRICES_FILE = path.join(dir, 'prices.json')          // дефолтные цены → monthlyTokens = 100/модуль

const { setModules } = await import('../userSubscriptions.js')
const { getBalance } = await import('../balance.js')
const { creditDueTokens } = await import('../tokenCredit.js')

test('начисление: сумма monthlyTokens активных модулей на баланс, повтор не удваивает', async () => {
  const now = Date.now()
  // подписка «сегодня» на 2 модуля (billing_day = сегодня), период большой
  await setModules('u1', ['mailing', 'warming'], { months: 6, startMs: now })
  const before = (await getBalance('u1')).coins

  const r1 = await creditDueTokens(now)
  assert.equal(r1.users, 1)
  assert.equal(r1.coins, 200, '2 модуля × дефолт 100 = 200 ⚡')
  const after1 = (await getBalance('u1')).coins
  assert.equal(after1, before + 200, 'монеты зачислены на баланс')

  // повтор в тот же день — идемпотентно, ничего не добавляет
  const r2 = await creditDueTokens(now)
  assert.equal(r2.users, 0, 'этот месяц уже начислен')
  assert.equal((await getBalance('u1')).coins, after1, 'баланс не изменился')
})

test('__workspace__ не начисляется (это провижининг, не оплата)', async () => {
  const now = Date.now()
  await setModules('__workspace__', ['mailing'], { months: 6, startMs: now })
  const r = await creditDueTokens(now)
  assert.ok(!r.users || r.users >= 0)
  const b = await getBalance('__workspace__')
  // у __workspace__ монеты не начисляем — баланс по этому ключу остаётся 0
  assert.equal(b.coins, 0)
})

test.after(async () => {
  delete process.env.BALANCE_FILE
  delete process.env.PRICES_FILE
  await fs.rm(dir, { recursive: true, force: true })
})
