/**
 * Совпадение ключа с названием канала при выдаче из своей базы (27.08).
 *
 * Прогон владельца: по ключам «массаж / СТО / нужен разработчик» в выдаче оказался
 * «Вкусный Чат — о еде, ресторанах». Искали подстроку, и «СТО» находило «ре-СТО-раны».
 * Главное, что здесь закрывается: мусор из середины слова не проходит, а словоформы
 * («Массажист», «Массажа») — проходят, потому что человек ищет именно их.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keywordRegex, matchesAny } from '../lib/keywordMatch.js'

const match = (kw, text) => keywordRegex(kw).test(text)

test('короткий ключ ищется целым словом — «СТО» не находит рестораны и стоматологию', () => {
  assert.equal(match('СТО', 'Вкусный Чат 🍜 — о еде, ресторанах, рецепты'), false)
  assert.equal(match('СТО', 'Стоматология №1'), false)
  assert.equal(match('СТО', 'СТО Ростов · автосервис'), true)
  assert.equal(match('СТО', 'Автосервис и СТО'), true)
})

test('длинный ключ ищется с начала слова — словоформы находятся', () => {
  assert.equal(match('массаж', 'Массаж тела и лица'), true)
  assert.equal(match('массаж', 'Массажист Ростов'), true, 'словоформа должна находиться')
  assert.equal(match('массаж', 'Школа Массажа Панфилова'), true)
  // А вот в середине слова — не находится: именно это давало мусор.
  assert.equal(match('ажист', 'Массажист Ростов'), false)
})

test('фраза из нескольких слов ищется целиком', () => {
  assert.equal(match('нужен разработчик', 'нужен разработчик в команду'), true)
  assert.equal(match('создать бота', 'Как создать бота за час'), true)
  assert.equal(match('создать бота', 'создать канал и бота'), false)
})

test('латиница и юзернеймы: регистр и подчёркивания не мешают', () => {
  assert.equal(match('massage', '@max_massage_sport_channel'), true)
  assert.equal(match('MASSAGE', 'Massage & Spa'), true)
  assert.equal(match('developer', 'Need developer now'), true)
})

test('спецсимволы в ключе не ломают регулярное выражение', () => {
  assert.doesNotThrow(() => keywordRegex('c++ (разработка)'))
  assert.equal(match('c++', 'Курсы c++ с нуля'), true)
  assert.equal(keywordRegex('').test('что угодно'), false)
})

test('matchesAny: совпадение хотя бы с одним ключом', () => {
  const res = ['массаж', 'СТО'].map(keywordRegex)
  assert.equal(matchesAny('Массажист Ростов', res), true)
  assert.equal(matchesAny('Вкусный Чат — о ресторанах', res), false)
})
