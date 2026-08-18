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

test('чёрный список действует и на получателей мейлинга', async () => {
  // Раньше ЧС применялся только к каналам и группам (через targets()), а получатели
  // рассылки шли мимо: человеку, которого явно занесли в список, спокойно уходило
  // личное сообщение. В ЛС это не «лишний показ», а прямая жалоба.
  const bl = await import('../targetBlacklist.js')
  await bl.setBlacklist(['@spamhater', '+380 50 123-45-67'])

  const { classifyMailingTargets } = await import('../lib/mailing.js')
  const targets = classifyMailingTargets([
    '@spamhater',        // в списке по юзернейму
    '@normaluser',       // чистый
    '380501234567',      // тот же номер, что в списке, но записан иначе
    '380509999999',      // чистый номер
  ])

  const passed = targets.filter((t) => !bl.isBlacklistedMailingTarget(t.kind, t.value))
  assert.deepEqual(passed.map((t) => t.value), ['normaluser', '380509999999'])
})

test('номер в ЧС ловится независимо от формата записи', async () => {
  const bl = await import('../targetBlacklist.js')
  // В списке — без кода страны и с разделителями, как их обычно копируют из телефона.
  await bl.setBlacklist(['050 123 45 67'])

  // В рассылку тот же человек приходит с кодом страны и без пробелов.
  assert.equal(bl.isBlacklistedMailingTarget('phone', '380501234567'), true)
  assert.equal(bl.isBlacklistedMailingTarget('phone', '+38 (050) 123-45-67'), true)
  // Чужой номер, совпадающий только началом, блокировать нельзя.
  assert.equal(bl.isBlacklistedMailingTarget('phone', '380509999999'), false)
  // Слишком короткая строка — не номер, а мусор: не блокируем.
  assert.equal(bl.isBlacklistedMailingTarget('phone', '12345'), false)

  await bl.setBlacklist([])
})
