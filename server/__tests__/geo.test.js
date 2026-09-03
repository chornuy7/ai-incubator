import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countryFromPhone } from '../accountsMeta.js'

test('countryFromPhone: GEO-модель Европа+Украина/СНГ (§8.3)', () => {
  assert.equal(countryFromPhone('+380671234567'), 'ua')
  assert.equal(countryFromPhone('+48512345678'), 'pl')
  assert.equal(countryFromPhone('+49 151 23456789'), 'de')
  assert.equal(countryFromPhone('+44 7700 900123'), 'gb')
  assert.equal(countryFromPhone('+33 6 12 34 56 78'), 'fr')
  assert.equal(countryFromPhone('+34612345678'), 'es')
  assert.equal(countryFromPhone('+39 320 1234567'), 'it')
  assert.equal(countryFromPhone('+31 6 12345678'), 'nl')
  assert.equal(countryFromPhone('+420 601 123456'), 'cz')
  assert.equal(countryFromPhone('+40 721 234 567'), 'ro')
  assert.equal(countryFromPhone('+370 612 34567'), 'lt')
  assert.equal(countryFromPhone('+371 21234567'), 'lv')
  // СНГ: Казахстан (77x) должен резолвиться раньше России (7).
  assert.equal(countryFromPhone('+7 701 234 5678'), 'kz')
  assert.equal(countryFromPhone('+7 916 123 4567'), 'ru')
  // США/Канада — единый план нумерации, отдаём us.
  assert.equal(countryFromPhone('+1 618 450 7132'), 'us')
  assert.equal(countryFromPhone('+19518558554'), 'us')
  // Неизвестный префикс — пусто, а не «украинский по умолчанию»:
  // молчаливый дефолт делал все импортированные номера украинскими.
  assert.equal(countryFromPhone('+000'), '')
  assert.equal(countryFromPhone(''), '')
})
