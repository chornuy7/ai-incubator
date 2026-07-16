import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanMailingNumbers, pickMailingAccount } from '../lib/mailing.js'

test('cleanMailingNumbers: нормализует, дедуплицирует, отбрасывает короткие', () => {
  const out = cleanMailingNumbers([' +380 (97) 270-05-34 ', '380972700534', '+48512345678', '123', '', null, 'abc'])
  assert.deepEqual(out, ['380972700534', '48512345678']) // дубль схлопнут, '123'/пустые/буквы отброшены
  assert.deepEqual(cleanMailingNumbers(undefined), [])
})

test('pickMailingAccount: round-robin, пропускает dm-лимит и maxPerAccount', () => {
  const usable = ['a', 'b', 'c']
  // старт с 0, никто не исчерпан → берём a, idx→1
  let r = pickMailingAccount(usable, 0, {})
  assert.deepEqual(r, { account: 'a', idx: 1 })
  // b исчерпал dm → пропускаем, берём c
  r = pickMailingAccount(usable, 1, { isDmReached: (id) => id === 'b' })
  assert.deepEqual(r, { account: 'c', idx: 0 })
  // maxPerAccount: a уже отправил 2 при лимите 2 → пропуск, берём b
  r = pickMailingAccount(usable, 0, { perAccSent: { a: 2 }, maxPerAccount: 2 })
  assert.deepEqual(r, { account: 'b', idx: 2 })
  // все исчерпаны → null
  r = pickMailingAccount(usable, 0, { isDmReached: () => true })
  assert.equal(r.account, null)
})
