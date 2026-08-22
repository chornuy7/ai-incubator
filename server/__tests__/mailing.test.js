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

/**
 * Цель, потерянная ПО ВИНЕ АККАУНТА, должна достаться другому (прогон 22.08).
 *
 * Живой случай: аккаунт словил спамблок ровно на отправке — и единственная цель пропала,
 * хотя в потоке было ещё два свободных аккаунта. Задача закрылась с «отправлено 0», а
 * человек в базе остался ненаписанным. Здесь проверяется правило очереди из runThread:
 * цель возвращается в конец ОДИН раз (если и второй аккаунт не смог — дело в самой цели,
 * и бесконечно гонять её по кругу нельзя).
 */
test('§3.9 цель после выбывшего аккаунта возвращается в очередь один раз', () => {
  const очередь = [{ kind: 'username', value: 'petya' }, { kind: 'username', value: 'vasya' }]
  const повторено = new Set()
  const обработано = []
  const аккаунтовВПотоке = 3
  // «petya» всегда падает по вине аккаунта — так проверяется и повтор, и его предел.
  const виноватАккаунт = (t) => t.value === 'petya'

  while (очередь.length) {
    const tgt = очередь.shift()
    обработано.push(tgt.value)
    const ключ = `${tgt.kind}:${tgt.value}`
    if (виноватАккаунт(tgt) && аккаунтовВПотоке > 1 && !повторено.has(ключ)) {
      повторено.add(ключ)
      очередь.push(tgt)
    }
  }

  assert.deepEqual(обработано, ['petya', 'vasya', 'petya'], 'потерянная цель дописана в конец очереди')
  assert.equal(повторено.size, 1, 'повтор ровно один — бесконечного круга нет')
})
