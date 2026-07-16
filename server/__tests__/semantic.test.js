import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosineSimilarity, rankBySimilarity } from '../lib/semantic.js'

test('cosineSimilarity: идентичные=1, ортогональные=0, разной длины/пустые=0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9) // ~0.707
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0) // разная длина
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0) // нулевой вектор
})

test('rankBySimilarity: сортировка по убыванию + порог', () => {
  const items = [
    { id: 'far', v: [0, 1] },
    { id: 'near', v: [1, 0.1] },
    { id: 'mid', v: [1, 1] },
  ]
  const q = [1, 0]
  const ranked = rankBySimilarity(items, q, (it) => it.v)
  assert.deepEqual(ranked.map((x) => x.item.id), ['near', 'mid', 'far'])
  // порог отсекает далёкие
  const filtered = rankBySimilarity(items, q, (it) => it.v, 0.9)
  assert.deepEqual(filtered.map((x) => x.item.id), ['near'])
})
