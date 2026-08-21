import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtWait, noteWait, finishNote } from '../modules/workers.js'

/**
 * Правка 20.08 (просьба владельца): «все задержки выводим в лог и суммируем».
 * До неё в логе были видны только вступление в канал, простой из-за усталости и разбег
 * стартов парсера — а основные паузы между действиями не оставляли следа, и объяснить,
 * почему за час сделано пять комментариев, было нечем.
 */

test('fmtWait говорит по-человечески: секунды, минуты, часы', () => {
  assert.equal(fmtWait(47_000), '47 с')
  assert.equal(fmtWait(89_000), '89 с', 'до полутора минут держим секунды — так точнее')
  assert.equal(fmtWait(5 * 60_000), '5 мин')
  assert.equal(fmtWait(72 * 60_000), '72 мин')
  assert.equal(fmtWait(95 * 60_000), '1 ч 35 мин')
})

test('noteWait копит сумму и пишет строку в лог', async () => {
  const written = []
  const store = { appendLog: async (_t, level, message, acc) => { written.push({ level, message, acc }) } }
  const task = { progress: { done: 0, total: 3 } }

  await noteWait(task, store, 42_000, 'задержка перед комментарием', 'Аккаунт-1')
  await noteWait(task, store, 18_000, 'прочитать и набрать ответ (3 с + 15 с)', 'Аккаунт-1')

  assert.equal(task.progress.waitMs, 60_000, 'сумма — это ответ на «сколько задача простояла»')
  assert.deepEqual(written.map((w) => w.message), [
    'Пауза 42 с — задержка перед комментарием',
    'Пауза 18 с — прочитать и набрать ответ (3 с + 15 с)',
  ])
  assert.equal(written[0].acc, 'Аккаунт-1', 'в логе видно, чей аккаунт ждал')
  assert.equal(written[0].level, 'info')
})

test('noteWait игнорирует пустую паузу и не портит прогресс', async () => {
  const store = { appendLog: async () => { throw new Error('лога быть не должно') } }
  const task = { progress: { done: 1, total: 2 } }
  await noteWait(task, store, 0, 'ничего')
  await noteWait(task, store, -5, 'ничего')
  assert.equal(task.progress.waitMs, undefined)
})

test('итоговая строка показывает суммарное ожидание', () => {
  assert.equal(finishNote({ status: 'done', progress: { waitMs: 8 * 60_000 } }), 'Завершено · в паузах 8 мин')
  assert.equal(finishNote({ status: 'stopped', progress: { waitMs: 30_000 } }), 'Остановлено · в паузах 30 с')
  // Без пауз хвоста нет — не мусорим в логе там, где сказать нечего.
  assert.equal(finishNote({ status: 'done', progress: {} }), 'Завершено')
  assert.equal(finishNote({ status: 'paused' }), 'Пауза')
})
