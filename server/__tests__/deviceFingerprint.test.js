import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateFingerprint, accountFingerprint, TDESKTOP_API_ID } from '../lib/deviceFingerprint.js'

test('генератор стабилен: один аккаунт — всегда один и тот же отпечаток', () => {
  // Плавающий отпечаток хуже отсутствующего: для Telegram это постоянная смена устройства.
  const a = generateFingerprint('acc_1234567890ab')
  const b = generateFingerprint('acc_1234567890ab')
  assert.deepEqual(a, b)
})

test('у разных аккаунтов отпечатки разные — иначе они связываются в одну пачку', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `acc_${i.toString(16).padStart(12, '0')}`)
  const fps = ids.map((id) => generateFingerprint(id))
  const uniq = new Set(fps.map((f) => `${f.device}|${f.system}|${f.appVersion}`))
  // Пул конечен, поэтому полного совпадения 1:1 не ждём, но разнообразие должно быть высоким.
  assert.ok(uniq.size >= 40, `слишком мало вариантов: ${uniq.size} на 60 аккаунтов`)
})

test('генератор выдаёт правдоподобные значения, а не заглушки', () => {
  const f = generateFingerprint('acc_test')
  assert.equal(f.apiId, TDESKTOP_API_ID)
  assert.match(f.system, /^Windows (10|11) x64$/)
  assert.match(f.appVersion, /^\d+\.\d+\.\d+ x64$/)
  assert.ok(f.device && f.device.length > 2)
  assert.equal(f.langCode, 'en')
})

test('accountFingerprint: отпечаток из meta главнее сгенерированного', () => {
  const meta = { fingerprint: { apiId: 2040, apiHash: 'abc', device: 'SJV50PU', system: 'Windows 11 x64', appVersion: '6.9.3 x64', langCode: 'en', systemLangCode: 'en-US' } }
  assert.deepEqual(accountFingerprint('acc_1', meta), meta.fingerprint)
})

test('accountFingerprint: частичный отпечаток из json дополняется, а не роняется в дефолт GramJS', () => {
  // В json бывает только app_id — остальное дописываем своим, иначе в эфир уйдут
  // одинаковые для всех значения библиотеки.
  const f = accountFingerprint('acc_2', { fingerprint: { apiId: 12345, apiHash: 'hash' } })
  assert.equal(f.apiId, 12345)
  assert.equal(f.apiHash, 'hash')
  assert.ok(f.device, 'модель устройства дописана')
  assert.ok(f.system, 'версия системы дописана')
  assert.equal(f, f) // sanity
})

test('accountFingerprint: без meta всё равно возвращает отпечаток, а не пустоту', () => {
  const f = accountFingerprint('acc_3')
  assert.ok(f && f.device && f.apiId)
  assert.deepEqual(f, accountFingerprint('acc_3', {}), 'пустая meta = отсутствующей')
})

test('accountFingerprint: разные аккаунты без json не получают одинаковый отпечаток', () => {
  const a = accountFingerprint('acc_aaaaaaaaaaaa')
  const b = accountFingerprint('acc_bbbbbbbbbbbb')
  assert.notDeepEqual(a, b)
})
