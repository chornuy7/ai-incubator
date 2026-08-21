/**
 * Человеческие тайминги (просьба владельца 21.08: «сколько печатает в среднем человек,
 * взять минимум и максимум, высчитать как рандом и вставить в задержку; точно так же по
 * переключению между модулями — и я должен видеть это в логе»).
 *
 * Тест сторожит не «магию», а происхождение чисел: диапазон набора должен оставаться
 * вокруг замеров (Aalto/Cambridge/ETH 2019: среднее 36 слов/мин на телефоне, 75% ниже 44),
 * а пауза переключения — вокруг resumption lag (порядка 25 секунд), а не вокруг
 * популярных «23 минут», которые про возвращение к прерванной сложной работе.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  TYPING_WPM, SWITCH_MS, typingPlan, switchPause, pickInRange, fmtDelay, describeTyping,
} from '../lib/humanDelays.js'

test('скорость набора взята из замеров: диапазон вокруг 36 слов/мин', () => {
  assert.ok(TYPING_WPM.min >= 20 && TYPING_WPM.min <= 30, `нижняя граница ${TYPING_WPM.min} — не похоже на «одним пальцем» (29)`)
  assert.ok(TYPING_WPM.max >= 40 && TYPING_WPM.max <= 50, `верхняя ${TYPING_WPM.max} — выше 75-го процентиля выборки (44)`)
  const mid = (TYPING_WPM.min + TYPING_WPM.max) / 2
  assert.ok(mid >= 32 && mid <= 40, `середина ${mid} должна быть рядом со средним по выборке (36)`)
})

test('пауза переключения — resumption lag, а не «23 минуты»', () => {
  assert.ok(SWITCH_MS.min >= 5_000, 'мгновенное переключение — сигнатура бота')
  assert.ok(SWITCH_MS.max <= 90_000, 'полторы минуты — уже не переключение, а перерыв')
  const mid = (SWITCH_MS.min + SWITCH_MS.max) / 2
  assert.ok(mid >= 15_000 && mid <= 35_000, `середина ${mid / 1000} с должна быть около 25 с`)
})

test('набор считается от длины текста и скорость каждый раз своя', () => {
  const short = typingPlan('Привет', 0, () => 0.5)
  const long = typingPlan(Array(100).fill('слово').join(' '), 0, () => 0.5)
  assert.ok(long.typeMs > short.typeMs * 10, '100 слов не набираются как одно')
  // Одинаковый темп у полусотни аккаунтов — сам по себе признак фермы.
  const slow = typingPlan('одно два три', 0, () => 0)      // самый медленный из диапазона
  const fast = typingPlan('одно два три', 0, () => 1)      // самый быстрый
  assert.ok(slow.typeMs > fast.typeMs, 'разброс скорости должен влиять на длительность')
  assert.equal(slow.wpm, TYPING_WPM.min)
  assert.equal(fast.wpm, TYPING_WPM.max)
})

test('чтение входящего: мгновенного ответа не бывает', () => {
  const p = typingPlan('Ответ', 200, () => 0.5)
  assert.ok(p.readMs >= 3000, 'меньше трёх секунд на чтение — сигнатура бота')
  const longer = typingPlan('Ответ', 3000, () => 0.5)
  assert.ok(longer.readMs > p.readMs, 'длинное сообщение читается дольше')
})

test('переключение случайно внутри диапазона', () => {
  assert.equal(switchPause(() => 0), SWITCH_MS.min)
  assert.equal(switchPause(() => 1), SWITCH_MS.max)
  const mid = switchPause(() => 0.5)
  assert.ok(mid > SWITCH_MS.min && mid < SWITCH_MS.max)
})

test('pickInRange не зависит от порядка границ', () => {
  assert.equal(pickInRange({ min: 10, max: 2 }, () => 0), 2)
  assert.equal(pickInRange({ min: 10, max: 2 }, () => 1), 10)
})

test('подписи для логов читаются человеком', () => {
  assert.equal(fmtDelay(1500), '1.5 с')
  assert.equal(fmtDelay(14_000), '14 с')
  assert.equal(fmtDelay(65_000), '1 мин 5 с')
  assert.equal(fmtDelay(120_000), '2 мин')
  // В логе должны стоять ЧИСЛА, иначе «пауза 14 с» выглядит взятой с потолка —
  // ровно эта претензия и была: «непонятно, как считает».
  const line = describeTyping(typingPlan('одно два три четыре', 0, () => 0.5))
  assert.match(line, /4 сл\./)
  assert.match(line, /сл\/мин/)
})
