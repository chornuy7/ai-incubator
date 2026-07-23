/**
 * AND-пересечение парсера и его выживание при «Продолжить». Баг (аудит 23.07): карта
 * совпадений жила только в памяти, при возобновлении была пустой, и финальное
 * пересечение выбрасывало всё, собранное до паузы. Клиент платил за строки, которых
 * не получал (деньги возвращались, но результат терялся).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeHits, restoreHits, keepIntersecting, channelKey } from '../lib/parserIntersect.js'

test('оставляет только каналы, совпавшие со ВСЕМИ ключами', () => {
  const results = [{ username: 'A' }, { username: 'B' }, { id: 'C' }]
  const hits = new Map([['a', new Set([0, 1])], ['b', new Set([0])], ['c', new Set([0, 1])]])
  const kept = keepIntersecting(results, hits, 2)
  assert.deepEqual(kept.map((r) => r.username || r.id), ['A', 'C'], 'B совпал только с одним ключом')
})

test('лимит режет уже после пересечения', () => {
  const results = [{ username: 'A' }, { username: 'B' }]
  const hits = new Map([['a', new Set([0, 1])], ['b', new Set([0, 1])]])
  assert.equal(keepIntersecting(results, hits, 2, 1).length, 1)
  assert.equal(keepIntersecting(results, hits, 2, Infinity).length, 2)
})

test('пустая карта выбрасывает всё — ровно тот случай, что был при resume', () => {
  const results = [{ username: 'A' }, { username: 'B' }]
  assert.equal(keepIntersecting(results, new Map(), 2).length, 0)
})

test('сериализация карты — обратимая: то, что переживает паузу', () => {
  const map = new Map([['a', new Set([0, 2])], ['b', new Set([1])]])
  const round = restoreHits(serializeHits(map))
  assert.deepEqual([...round.get('a')], [0, 2])
  assert.deepEqual([...round.get('b')], [1])
  // serializeHits даёт JSON-совместимый объект (уходит в task на диск).
  const json = JSON.parse(JSON.stringify(serializeHits(map)))
  assert.deepEqual(json, { a: [0, 2], b: [1] })
})

test('resume не теряет собранное до паузы: карта восстановлена — каналы уцелели', () => {
  // До паузы собрали 2 канала и записали их хиты в задачу.
  const beforePause = new Map([['a', new Set([0])], ['b', new Set([0])]])
  const persisted = serializeHits(beforePause)

  // После «Продолжить» карта пустая (новый процесс), НО восстановлена из задачи,
  // и второй ключ (индекс 1) домечает те же каналы.
  const resumed = restoreHits(persisted)
  resumed.get('a').add(1)
  resumed.get('b').add(1)

  const results = [{ username: 'A' }, { username: 'B' }]
  const kept = keepIntersecting(results, resumed, 2)
  assert.deepEqual(kept.map((r) => r.username), ['A', 'B'], 'без восстановления карты оба были бы потеряны')
})

test('channelKey: username важнее id, регистр не важен', () => {
  assert.equal(channelKey({ username: 'MyChan', id: '999' }), 'mychan')
  assert.equal(channelKey({ id: 'ABC' }), 'abc')
  assert.equal(channelKey({}), '')
})
