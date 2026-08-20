/**
 * MR-173: подписки реляционно (строка на модуль). Проверяем главное: докупка НЕ затирает
 * набор, повторная оплата не дублирует, истёкшие не отдаются, 'all' через '*', и MR-150
 * начисление токенов по дню оплаты идемпотентно.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usub-'))
process.env.USER_SUBS_FILE = path.join(dir, 'user-subscriptions.json')

const { readModules, setModules, addModules, dueForCredit, markCredited, ALL_MODULES } = await import('../userSubscriptions.js')

const DAY = 24 * 60 * 60 * 1000

test('setModules: точный набор, читается активным', async () => {
  await setModules('u1', ['mailing', 'warming'], { months: 1 })
  const r = await readModules('u1')
  assert.deepEqual([...r.modules].sort(), ['mailing', 'warming'])
})

test('addModules: докупка НЕ затирает набор, возвращает только добавленные', async () => {
  const res = await addModules('u1', ['warming', 'autoposting'], { months: 1 }) // warming уже есть
  assert.deepEqual(res.added, ['autoposting'], 'платим только за реально добавленное')
  const r = await readModules('u1')
  assert.deepEqual([...r.modules].sort(), ['autoposting', 'mailing', 'warming'], 'старые модули на месте')
})

test('повторная «оплата» того же модуля не дублирует', async () => {
  await addModules('u1', ['mailing'], { months: 1 }) // mailing уже есть
  const r = await readModules('u1')
  assert.equal(r.modules.filter((m) => m === 'mailing').length, 1)
})

test('истёкшие модули не отдаются', async () => {
  // старт в прошлом так, чтобы срок (1 мес ≈ 30 дней) уже истёк
  await setModules('u2', ['mailing'], { months: 1, startMs: Date.now() - 40 * DAY })
  const r = await readModules('u2')
  assert.deepEqual(r.modules, [], 'подписка на модуль закончилась — модуль закрыт')
})

test("'all' представлен строкой '*'", async () => {
  await setModules('u3', 'all', { months: 1 })
  const r = await readModules('u3')
  assert.equal(r.modules, 'all')
})

test('MR-150: dueForCredit ловит подписки в день оплаты, markCredited гасит повтор', async () => {
  // оплата «сегодня» → billingDay = сегодня; период большой, чтобы не истекло
  const now = Date.now()
  await setModules('u4', ['mailing', 'warming'], { months: 6, startMs: now })
  const due1 = await dueForCredit(now)
  const mine1 = due1.find((x) => x.userId === 'u4')
  assert.ok(mine1, 'сегодня день начисления')
  assert.deepEqual([...mine1.modules].sort(), ['mailing', 'warming'])

  const month = `${new Date(now).getUTCFullYear()}-${String(new Date(now).getUTCMonth() + 1).padStart(2, '0')}`
  await markCredited('u4', mine1.ids, month)
  const due2 = await dueForCredit(now)
  assert.ok(!due2.find((x) => x.userId === 'u4'), 'этот месяц уже начислен — второй раз не берём')
})

test.after(async () => {
  delete process.env.USER_SUBS_FILE
  await fs.rm(dir, { recursive: true, force: true })
})
