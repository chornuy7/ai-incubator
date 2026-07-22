/**
 * §3.2/§3.3: один аккаунт в карантине не должен валить весь запуск.
 * Раньше guard отдавал только текст ошибки — человек шёл в менеджер аккаунтов
 * искать виноватого. Теперь наружу идёт состав: кого исключить и что останется.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

async function withMeta(meta, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assignable-'))
  const file = path.join(dir, 'accounts-meta.json')
  await fs.writeFile(file, JSON.stringify(meta), 'utf8')
  const prev = process.env.ACCOUNTS_META_FILE
  process.env.ACCOUNTS_META_FILE = file
  try {
    const mod = await import(`../accountsMeta.js?t=${Date.now()}`)
    return await fn(mod)
  } finally {
    if (prev === undefined) delete process.env.ACCOUNTS_META_FILE
    else process.env.ACCOUNTS_META_FILE = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('checkAccountsAssignable: делит на годных и заблокированных', async () => {
  await withMeta({
    a1: { status: 'active' },
    a2: { status: 'quarantine' },
    a3: { status: 'spamblock' },
    a4: { status: 'active' },
  }, async ({ checkAccountsAssignable }) => {
    const r = await checkAccountsAssignable(['a1', 'a2', 'a3', 'a4'], 'mailing')
    assert.deepEqual(r.usable, ['a1', 'a4'], 'годные должны остаться')
    assert.equal(r.blocked.length, 2)
    assert.deepEqual(r.blocked.map((b) => b.status).sort(), ['quarantine', 'spamblock'])
    assert.ok(r.error, 'текст ошибки нужен для случая, когда исключать нечего')
  })
})

test('все аккаунты в порядке — ошибки нет', async () => {
  await withMeta({ a1: { status: 'active' } }, async ({ checkAccountsAssignable }) => {
    const r = await checkAccountsAssignable(['a1'], 'mailing')
    assert.equal(r.error, null)
    assert.deepEqual(r.usable, ['a1'])
  })
})

test('не осталось ни одного годного — исключать бессмысленно', async () => {
  await withMeta({ a1: { status: 'quarantine' }, a2: { status: 'invalid' } }, async ({ checkAccountsAssignable }) => {
    const r = await checkAccountsAssignable(['a1', 'a2'], 'mailing')
    assert.equal(r.usable.length, 0, 'фронт по этому признаку не предложит «запустить без них»')
    assert.equal(r.blocked.length, 2)
  })
})

test('нейродиалоги берут спамблок — он попадает в годные, а не в блок', async () => {
  await withMeta({ a1: { status: 'spamblock' }, a2: { status: 'quarantine' } }, async ({ checkAccountsAssignable }) => {
    const r = await checkAccountsAssignable(['a1', 'a2'], 'neuro-dialogs')
    assert.deepEqual(r.usable, ['a1'], 'спамблок не мешает отвечать')
    assert.deepEqual(r.blocked.map((b) => b.id), ['a2'])
  })
})

test('пустой список аккаунтов — не ошибка', async () => {
  await withMeta({}, async ({ checkAccountsAssignable }) => {
    const r = await checkAccountsAssignable([], 'mailing')
    assert.equal(r.error, null)
  })
})
