import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCommentCandidates, postContainsAny } from '../lib/workerLoop.js'

test('postContainsAny: находит стоп-слово регистронезависимо', () => {
  assert.equal(postContainsAny('Купите КРИПТУ дёшево', ['крипт']), true)
  assert.equal(postContainsAny('Обычный пост', ['крипта', 'скам']), false)
  assert.equal(postContainsAny('текст', []), false)
})

test('pickCommentCandidates: стоп-слова вырезают посты (§3.5 фильтр)', () => {
  const posts = [
    { id: 3, message: 'Хороший пост про бизнес' },
    { id: 2, message: 'Политика и скандал' },
    { id: 1, message: 'ИИ автоматизация' },
  ]
  // без стоп-слов, режим «все существующие» (postFilter=1) — все 3
  const all = pickCommentCandidates(posts, { commentMode: 2, postFilter: 2 })
  assert.equal(all.length, 3)
  // стоп-слово «политика» вырезает 1 пост
  const filtered = pickCommentCandidates(posts, { commentMode: 2, postFilter: 2, stopWords: ['политика'] })
  assert.equal(filtered.length, 2)
  assert.ok(!filtered.some((p) => /Политика/.test(p.message)))
})
