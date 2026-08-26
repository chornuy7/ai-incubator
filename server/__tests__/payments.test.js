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
  // Владелец 26.08: «$80 я выдавал через админку» — такие деньги НЕ выручка.
  { ts: NOW - 2 * D, userId: 'u3', amount: 80, currency: 'usd', reason: 'Пополнение $ из админ-панели', kind: 'grant' },
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
await fs.writeFile(process.env.AUDIT_LOG_FILE, [
  { ts: NOW - 3 * D, action: 'subscription.set', initiator: 'u1', reason: 'Подписка', meta: { modules: ['mailing', 'ggr'], cost: { sum: 35 } } },
  { ts: NOW - 3 * D, action: 'subscription.set', initiator: 'u2', reason: 'все', meta: { modules: 'all', cost: null } }, // набор «все» — не покупка
  { ts: NOW - 2 * D, action: 'task.start', initiator: 'u1' }, // не подписка
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const { syncPayments, queryPayments, paymentsSummary } = await import('../payments.js')
await syncPayments()

test('индекс: положительные пополнения (⚡) + покупки планов ($), списания не идут', async () => {
  const { total, rows } = await queryPayments({})
  assert.equal(total, 5, '3 пополнения ⚡ + 1 план + 1 выдача $ (списание и набор «все» отброшены)')
  // Начисления разделены по происхождению: куплено / выдано — и для ⚡ (§3.2/MR-22),
  // и для долларов (26.08: ручная выдача из админки — не выручка).
  const kinds = new Set(rows.map((r) => r.kind))
  assert.deepEqual([...kinds].sort(), ['coins', 'grant', 'plan', 'usd_grant'], 'куплено, выдано ⚡, план, выдано $')
})

test('фильтр по типу', async () => {
  assert.equal((await queryPayments({ kind: 'coins' })).total, 1, 'куплено за деньги — одно')
  assert.equal((await queryPayments({ kind: 'grant' })).total, 2, 'выдано — два (подписка и ручное)')
  assert.equal((await queryPayments({ kind: 'plan' })).total, 1)
})

test('диапазон дат «месяц назад»: старое пополнение выпадает', async () => {
  const { total } = await queryPayments({ from: NOW - 6 * D, to: NOW })
  assert.equal(total, 4, 'u1 50 + u2 10 + план 35 + выдача $80; u1 100 (40 дней) вне окна')
})

test('поиск по пользователю', async () => {
  assert.equal((await queryPayments({ q: 'u2' })).total, 1)
})

test('пагинация: total полный, страница урезана', async () => {
  const p = await queryPayments({ limit: 2, offset: 0 })
  assert.equal(p.total, 5)
  assert.equal(p.rows.length, 2)
  const p2 = await queryPayments({ limit: 2, offset: 2 })
  assert.equal(p2.rows.length, 2)
})

test('§3.2: купленные токены — доход, выданные — нет', async () => {
  // «Подарочные токены из подписки не учитывать как отдельный доход: доходом является
  // покупка плана. Покупку дополнительных токенов учитывать как отдельную денежную
  // операцию.» Раньше сюда попадало ЛЮБОЕ начисление, и подписка считалась дважды:
  // как оплата плана и как выданные по ней токены.
  const s = await paymentsSummary({})
  assert.equal(s.coinsTotal, 100, 'только «Куплено за $…»')
  assert.equal(s.coinsCount, 1)
  assert.equal(s.grantTotal, 60, 'подарок 50 + ручное 10 — отдельно от дохода')
  assert.equal(s.grantCount, 2)
  assert.equal(s.planTotal, 35)
  assert.equal(s.planCount, 1)
})

test('повторный sync идемпотентен — дублей нет', async () => {
  await syncPayments()
  assert.equal((await queryPayments({})).total, 5, 'пересборка не задваивает строки')
})

/**
 * §3.2 (MR-22) различал «куплено / выдано» только для токенов. Для долларов различия не
 * было, и ручная выдача из админки попадала в выручку: владелец выдал $80 на тест — отчёт
 * показал их как полученные деньги.
 */
test('выданные из админки доллары не считаются выручкой', async () => {
  const s = await paymentsSummary({})
  assert.equal(s.usdGrantTotal, 80, 'выдача должна быть видна отдельной строкой')
  assert.equal(s.usdGrantCount, 1)
  assert.ok(!String(s.usdTotal).includes('80'), 'и не должна попадать в доход')
  // Строка при этом из витрины не пропадает — её видно с собственным типом.
  const { total } = await queryPayments({ kind: 'usd_grant' })
  assert.equal(total, 1)
})

test('пополнение БЕЗ пометки считается оплатой — задним числом подарками не объявляем', async () => {
  const { rows } = await queryPayments({ kind: 'usd' })
  // В фикстуре есть обычное пополнение долларами без kind — оно обязано остаться доходом.
  assert.ok(rows.every((r) => r.kind === 'usd'))
})
