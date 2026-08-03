/**
 * §11.1: хранение переписки. Решение владельца (03.08): храним ЦЕЛИКОМ, без обрезки.
 * Обрезка включается только явным env MESSAGES_MAX_TEXT (аварийный рычаг).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

async function fresh(env = {}) {
  const f = path.join(os.tmpdir(), `messages-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  process.env.MESSAGES_FILE = f
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  // MAX_TEXT читается на импорте — берём свежий модуль под нужный env.
  const M = await import('../messages.js?m=' + Math.random())
  return { M, f }
}

test('recordMessage: по умолчанию хранит текст ЦЕЛИКОМ (без обрезки)', async () => {
  delete process.env.MESSAGES_MAX_TEXT
  const { M, f } = await fresh()
  const big = 'x'.repeat(10000)
  await M.recordMessage({ accountId: 'acc1', direction: 'out', text: big, peer: '@a' })
  const list = await M.listMessages({ accountId: 'acc1' })
  assert.equal(list.length, 1)
  assert.equal(list[0].text.length, 10000, 'текст сохранён полностью')
  assert.ok(!list[0].text.includes('обрезано'), 'пометки об обрезке нет')
  await fs.rm(f, { force: true })
})

test('recordMessage: MESSAGES_MAX_TEXT режет и помечает обрезку', async () => {
  const { M, f } = await fresh({ MESSAGES_MAX_TEXT: '100' })
  await M.recordMessage({ accountId: 'acc1', direction: 'in', text: 'y'.repeat(500), peer: '@b' })
  const [msg] = await M.listMessages({ accountId: 'acc1' })
  assert.ok(msg.text.length <= 100 + 40, 'обрезано по лимиту (+ пометка)')
  assert.ok(msg.text.includes('обрезано'), 'есть пометка об обрезке')
  delete process.env.MESSAGES_MAX_TEXT
  await fs.rm(f, { force: true })
})

test('recordMessage: без accountId и с пустым текстом — не пишем (best-effort, только шум)', async () => {
  delete process.env.MESSAGES_MAX_TEXT
  const { M, f } = await fresh()
  await M.recordMessage({ direction: 'out', text: 'нет аккаунта' })
  await M.recordMessage({ accountId: 'acc1', direction: 'out', text: '' })
  assert.equal((await M.listMessages({})).length, 0)
  await fs.rm(f, { force: true })
})

test('listMessages: фильтр по аккаунту и лимит строк, свежие сверху', async () => {
  delete process.env.MESSAGES_MAX_TEXT
  const { M, f } = await fresh()
  await M.recordMessage({ accountId: 'a1', direction: 'out', text: 'первое', peer: '@x' })
  await M.recordMessage({ accountId: 'a2', direction: 'out', text: 'чужое', peer: '@y' })
  await M.recordMessage({ accountId: 'a1', direction: 'in', text: 'второе', peer: '@x' })
  const mine = await M.listMessages({ accountId: 'a1' })
  assert.equal(mine.length, 2, 'только свой аккаунт')
  assert.ok(mine.every((m) => m.accountId === 'a1'))
  const one = await M.listMessages({ limit: 1 })
  assert.equal(one.length, 1, 'лимит строк соблюдён')
  await fs.rm(f, { force: true })
})
