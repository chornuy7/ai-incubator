/**
 * C1–C2 (SPEC §5.1): расход токенов ИИ считается построчно и списывается монетами.
 * Без журнала C2 нечего списывать, а на вопрос «почему списалось столько» нечем ответить.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'))
process.env.TOKEN_LEDGER_FILE = path.join(dir, 'ledger.jsonl')
process.env.BALANCE_FILE = path.join(dir, 'balance.json')

const { recordTokens, readLedger, tokenSummary, tokensToCoins } = await import('../tokenLedger.js')
const { getBalance, changeCoins } = await import('../balance.js')

test('C1: курс токенов в монеты — до сотых', () => {
  assert.equal(tokensToCoins(1000), 1)
  assert.equal(tokensToCoins(2500), 2.5)
  assert.equal(tokensToCoins(0), 0)
  assert.equal(tokensToCoins(-5), 0, 'отрицательный расход невозможен')
})

test('C1: нулевой расход не засоряет журнал', async () => {
  assert.equal(await recordTokens({ tokens: 0, module: 'neuro-commenting' }), null)
  assert.equal((await readLedger()).length, 0)
})

test('C1+C2: расход пишется в журнал и списывается с баланса', async () => {
  await changeCoins(10)
  await recordTokens({ tokens: 2500, module: 'neuro-commenting', accountId: 'a1', taskId: 't1' })
  assert.equal((await getBalance()).coins, 7.5, 'за 2500 токенов списано 2.5 монеты')

  const rows = await readLedger({ taskId: 't1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tokens, 2500)
  assert.equal(rows[0].coins, 2.5)
  assert.equal(rows[0].module, 'neuro-commenting')
})

test('C2: списание не уводит баланс в минус', async () => {
  await recordTokens({ tokens: 100000, module: 'mailing', accountId: 'a2', taskId: 't1' })
  assert.equal((await getBalance()).coins, 0,
    'иначе правило «при нуле боевые модули стоят» стало бы непроверяемым')
})

test('C1: свод по задаче — разрез по модулям и аккаунтам', async () => {
  const s = await tokenSummary({ taskId: 't1' })
  assert.equal(s.calls, 2)
  assert.equal(s.tokens, 102500)
  assert.equal(s.byModule['neuro-commenting'], 2500)
  assert.equal(s.byModule.mailing, 100000)
  assert.equal(s.byAccount.a1, 2500)
})

test('C1: журнал отдаёт свежие сверху', async () => {
  const rows = await readLedger({ limit: 1 })
  assert.equal(rows[0].module, 'mailing', 'последняя запись — первой')
})

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.TOKEN_LEDGER_FILE
  delete process.env.BALANCE_FILE
})
