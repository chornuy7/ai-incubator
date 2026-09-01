/**
 * MR-290: перевод времени между базой и кодом.
 *
 * Проверяется не арифметика (её видно и так), а три ловушки, каждая из которых уже стоила
 * нам ошибки в проде: ноль как «никогда», ISO-строка под `Number()` и bigint, приехавший
 * строкой. Все три ломаются тихо — время не падает с исключением, оно просто становится
 * неправильным, и заметно это уже в отчёте.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toDbTime, fromDbTime, fromDbTimeOrNull } from '../lib/dbTime.js'

const MOMENT = 1787588909052 // 2026-08-11T…, конкретный момент, не «сейчас»

test('момент туда и обратно не теряет ни миллисекунды', () => {
  const iso = toDbTime(MOMENT)
  assert.equal(typeof iso, 'string')
  assert.equal(fromDbTime(iso), MOMENT)
})

test('ноль это «никогда», а не полночь 1970 года', () => {
  // Из-за обратного допущения интерфейс писал «отдыхает до 01.01.1970».
  assert.equal(toDbTime(0), null)
  assert.equal(toDbTime(null), null)
})

test('мусор на входе даёт NULL, а не исключение посреди сохранения', () => {
  // `new Date(NaN).toISOString()` бросает RangeError — уронило бы всю запись.
  for (const bad of ['', 'вчера', NaN, undefined, -1]) assert.equal(toDbTime(bad), null)
})

test('отрицательное время в базу не уезжает', () => {
  assert.equal(toDbTime(-MOMENT), null)
})

test('Date на входе принимается наравне с числом', () => {
  assert.equal(toDbTime(new Date(MOMENT)), toDbTime(MOMENT))
})

test('ISO-строка разбирается — на этом ломался раздел «планы» в отчёте', () => {
  // `Number('2026-08-11T…')` это NaN, и `Number(e.ts) || 0` отдавал ноль на каждой записи.
  assert.equal(fromDbTime('2026-08-11T00:00:00.000Z'), Date.parse('2026-08-11T00:00:00.000Z'))
})

test('bigint строкой разбирается как число, а не как дата', () => {
  // `new Date('1787588909052')` это Invalid Date: строку JS читает как дату, не как число.
  // Драйверы отдают bigint строкой, и на этом можно потерять всё время разом.
  assert.equal(fromDbTime(String(MOMENT)), MOMENT)
})

test('число из запасного SQLite понимается тем же чтением', () => {
  // Одна функция на оба хранилища — иначе в каждом сторе появилось бы ветвление.
  assert.equal(fromDbTime(MOMENT), MOMENT)
})

test('чтений два, потому что NULL и ноль значат разное', () => {
  // «Действий не было» это 0 для одних вызывающих и null для других — выбирает вызывающий.
  assert.equal(fromDbTime(null), 0)
  assert.equal(fromDbTimeOrNull(null), null)
  assert.equal(fromDbTimeOrNull('2026-08-11T00:00:00.000Z'), Date.parse('2026-08-11T00:00:00.000Z'))
})

test('битое значение из базы читается как «нет времени», а не как NaN', () => {
  // NaN, просочившийся в арифметику дат, отравляет весь отчёт молча.
  assert.equal(fromDbTime('не дата'), 0)
  assert.equal(fromDbTimeOrNull('не дата'), null)
})
