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
  // §3.2: покупка токенов за деньги — доход. У старых строк kind нет: их разбирают
  // по тексту причины, поэтому одну намеренно оставляем без kind.
  { ts: NOW - 40 * D, userId: 'u1', amount: 100, reason: 'Куплено за $10.00' },
  // Выданные токены (подарок/месячная выдача/ручное начисление) — НЕ доход.
  { ts: NOW - 5 * D, userId: 'u1', amount: 50, reason: 'Токены подписки: 2 модул. (первый месяц)', kind: 'grant' },
  { ts: NOW - 5 * D, userId: 'u2', amount: 10, reason: 'пополнение' },
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
  // Начисления ⚡ теперь разделены: купленные ('coins') и выданные ('grant') — §3.2.
  const kinds = new Set(rows.map((r) => r.kind))
  assert.deepEqual([...kinds].sort(), ['coins', 'grant', 'plan'], 'три типа: куплено, выдано, план')
})

test('фильтр по типу', () => {
  assert.equal(queryPayments({ kind: 'coins' }).total, 1, 'куплено за деньги — одно')
  assert.equal(queryPayments({ kind: 'grant' }).total, 2, 'выдано — два (подписка и ручное)')
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

test('§3.2: купленные токены — доход, выданные — нет', () => {
  // «Подарочные токены из подписки не учитывать как отдельный доход: доходом является
  // покупка плана. Покупку дополнительных токенов учитывать как отдельную денежную
  // операцию.» Раньше сюда попадало ЛЮБОЕ начисление, и подписка считалась дважды:
  // как оплата плана и как выданные по ней токены.
  const s = paymentsSummary({})
  assert.equal(s.coinsTotal, 100, 'только «Куплено за $…»')
  assert.equal(s.coinsCount, 1)
  assert.equal(s.grantTotal, 60, 'подарок 50 + ручное 10 — отдельно от дохода')
  assert.equal(s.grantCount, 2)
  assert.equal(s.planTotal, 35)
  assert.equal(s.planCount, 1)
})

test('повторный sync идемпотентен — дублей нет', async () => {
  await syncPayments()
  assert.equal(queryPayments({}).total, 4, 'пересборка не задваивает строки')
})
