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
// Изолируем прайс: recordTokens теперь читает админский курс coinsPer1kTokens из priceStore.
process.env.PRICES_FILE = path.join(dir, 'prices.json')

const { recordTokens, readLedger, tokenSummary, tokensToCoins } = await import('../tokenLedger.js')
const { getBalance, changeCoins } = await import('../balance.js')
const { setOverrides } = await import('../priceStore.js')

test('C1: курс токенов в монеты — до тысячных', () => {
  assert.equal(tokensToCoins(1000), 1)
  assert.equal(tokensToCoins(2500), 2.5)
  assert.equal(tokensToCoins(0), 0)
  assert.equal(tokensToCoins(-5), 0, 'отрицательный расход невозможен')
})

test('C1: нулевой расход не засоряет журнал', async () => {
  assert.equal(await recordTokens({ tokens: 0, module: 'neuro-commenting' }), null)
  assert.equal((await readLedger()).length, 0)
})

test('MR-149: расход пишется в журнал, но монеты за токены НЕ списываются (одна цена за действие)', async () => {
  await changeCoins(10)
  const before = (await getBalance()).coins
  await recordTokens({ tokens: 2500, module: 'neuro-commenting', accountId: 'a1', taskId: 't1' })
  assert.equal((await getBalance()).coins, before, 'баланс не меняется — за текст берёт фикс-цена действия')

  const rows = await readLedger({ taskId: 't1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tokens, 2500)
  assert.equal(rows[0].coins, 2.5, 'в журнале — СПРАВОЧНАЯ стоимость токенов, не списание')
  assert.equal(rows[0].module, 'neuro-commenting')
})

test('MR-149: большой расход токенов не списывает деньги (платит цена действия)', async () => {
  const before = (await getBalance()).coins
  await recordTokens({ tokens: 100000, module: 'mailing', accountId: 'a2', taskId: 't1' })
  assert.equal((await getBalance()).coins, before, 'токены журналируются, но с баланса не списываются')
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

test('§10.5: coinMultiplier наценивает СПРАВОЧНУЮ стоимость токенов в журнале (деньги не трогаем)', async () => {
  const before = (await getBalance()).coins
  const row = await recordTokens({ tokens: 1000, module: 'neuro-dialogs', taskId: 'img', coinMultiplier: 4 })
  assert.equal(row.tokens, 1000, 'в журнале честное число токенов')
  assert.equal(row.coins, 4, '1000 токенов ×4 = 4 монеты (справочно)')
  assert.equal((await getBalance()).coins, before, 'баланс не меняется — за токены не списываем (MR-149)')
})

test('§10.5: множитель <1 или мусор игнорируется (не удешевляет расход)', async () => {
  const a = await recordTokens({ tokens: 1000, module: 'm', taskId: 'img2', coinMultiplier: 0.1 })
  assert.equal(a.coins, 1, 'множитель <1 не применяется — минимум ×1')
  const b = await recordTokens({ tokens: 1000, module: 'm', taskId: 'img2', coinMultiplier: 'x' })
  assert.equal(b.coins, 1, 'нечисловой множитель = ×1')
})

test('§10.1: точность до тысячных — 5 токенов не округляются до 0.01 и не в 0', async () => {
  const r = await recordTokens({ tokens: 5, module: 'm', taskId: 'prec' })
  assert.equal(r.coins, 0.005, '5 токенов = 0.005 монеты (а не 0.01 и не 0)')
})

test('§10.1: АДМИНСКИЙ курс токен→монета влияет на списание (не только на витрину)', async () => {
  await setOverrides({ coinsPer1kTokens: 5 }) // админ поднял курс в 5 раз
  const r = await recordTokens({ tokens: 1000, module: 'm', taskId: 'rate' })
  assert.equal(r.coins, 5, '1000 токенов при курсе 5 = 5 монет (курс из БД применён)')
  const withMult = await recordTokens({ tokens: 1000, module: 'm', taskId: 'rate', coinMultiplier: 4 })
  assert.equal(withMult.coins, 20, 'курс ×5 и картинка ×4 перемножаются: 5×4=20')
  await setOverrides({ coinsPer1kTokens: 1 }) // вернуть, чтобы не влиять на другие тесты в файле
})

test.after(async () => {
  delete process.env.PRICES_FILE
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.TOKEN_LEDGER_FILE
  delete process.env.BALANCE_FILE
})
