/**
 * §5.1: база оплат (SQLite-индекс). Проверяем, что «глянуть месяц назад» и поиск
 * работают: индекс собирается из источников (wallet-log + журнал подписок), даёт
 * диапазон дат, тип (монеты/планы), пагинацию и сходящиеся итоги. Списания —
 * не покупка и в индекс не идут.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const tmp = (ext) => path.join(os.tmpdir(), `pay-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`)
const D = 86_400_000
const NOW = 1_700_000_000_000 // фиксированная точка — тест детерминирован

// Env читается функциями внутри модуля, поэтому ставим ДО первого обращения к БД.
process.env.PAYMENTS_DB = tmp('db')
process.env.WALLET_LOG_FILE = tmp('jsonl')
process.env.AUDIT_LOG_FILE = tmp('jsonl')

await fs.rm(process.env.PAYMENTS_DB, { force: true })
await fs.writeFile(process.env.WALLET_LOG_FILE, [
  { ts: NOW - 40 * D, userId: 'u1', amount: 100, reason: 'пополнение' },
  { ts: NOW - 5 * D, userId: 'u1', amount: 50, reason: 'пополнение' },
  { ts: NOW - 5 * D, userId: 'u2', amount: 10, reason: 'x' },
  { ts: NOW - 1 * D, userId: 'u1', amount: -7, reason: 'списание за ИИ' }, // не покупка
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
await fs.writeFile(process.env.AUDIT_LOG_FILE, [
  { ts: NOW - 3 * D, action: 'subscription.set', initiator: 'u1', reason: 'Подписка', meta: { modules: ['mailing', 'ggr'], cost: { sum: 35 } } },
  { ts: NOW - 3 * D, action: 'subscription.set', initiator: 'u2', reason: 'все', meta: { modules: 'all', cost: null } }, // набор «все» — не покупка
  { ts: NOW - 2 * D, action: 'task.start', initiator: 'u1' }, // не подписка
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const { syncPayments, queryPayments, paymentsSummary } = await import('../payments.js')
await syncPayments()

test('индекс: положительные пополнения (⚡) + покупки планов ($), списания не идут', () => {
  const { total, rows } = queryPayments({})
  assert.equal(total, 4, '3 пополнения + 1 план (списание и набор «все» отброшены)')
  assert.equal(rows.filter((r) => r.kind === 'coins').length + rows.filter((r) => r.kind === 'plan').length, rows.length)
})

test('фильтр по типу', () => {
  assert.equal(queryPayments({ kind: 'coins' }).total, 3)
  assert.equal(queryPayments({ kind: 'plan' }).total, 1)
})

test('диапазон дат «месяц назад»: старое пополнение выпадает', () => {
  const { total } = queryPayments({ from: NOW - 6 * D, to: NOW })
  assert.equal(total, 3, 'u1 50 + u2 10 + план 35; u1 100 (40 дней) вне окна')
})

test('поиск по пользователю', () => {
  assert.equal(queryPayments({ q: 'u2' }).total, 1)
})

test('пагинация: total полный, страница урезана', () => {
  const p = queryPayments({ limit: 2, offset: 0 })
  assert.equal(p.total, 4)
  assert.equal(p.rows.length, 2)
  const p2 = queryPayments({ limit: 2, offset: 2 })
  assert.equal(p2.rows.length, 2)
})

test('итоги сходятся: монеты и планы считаются отдельно', () => {
  const s = paymentsSummary({})
  assert.equal(s.coinsTotal, 160, '100 + 50 + 10')
  assert.equal(s.coinsCount, 3)
  assert.equal(s.planTotal, 35)
  assert.equal(s.planCount, 1)
})

test('повторный sync идемпотентен — дублей нет', async () => {
  await syncPayments()
  assert.equal(queryPayments({}).total, 4, 'пересборка не задваивает строки')
})
