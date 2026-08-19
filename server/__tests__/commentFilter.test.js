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

/**
 * Разделение «что подходит» и «сколько брать» (правка 18.08).
 *
 * В интерфейсе стояли две группы, которые спорили: «Случайный / По ключевым словам /
 * Все посты» и «Только новые / Только существующие / Все посты» — «Все посты» дважды, а
 * «случайный» выглядел взаимоисключающим с «по ключевым словам», хотя это разные вопросы.
 */
const posts = (...ids) => ids.map((id) => ({ id, message: `пост ${id} про крипту` }))

test('глубина «последние N» отсчитывается по ленте канала', () => {
  const out = pickCommentCandidates(posts(10, 9, 8, 7, 6), { postFilter: 3, lastPostsCount: 2, commentMode: 2, pickOne: false })
  assert.deepEqual(out.map((p) => p.id).sort((a, b) => b - a), [10, 9])
})

test('N по ленте, а не по прошедшим фильтр: жёсткие ключи не уводят вглубь истории', () => {
  const list = [
    { id: 10, message: 'без ключа' },
    { id: 9, message: 'без ключа' },
    { id: 8, message: 'про крипту' },
  ]
  const out = pickCommentCandidates(list, { postFilter: 3, lastPostsCount: 2, commentMode: 1, keywords: ['крипт'], pickOne: false })
  assert.deepEqual(out, [], 'пост №8 подходит по словам, но в двойку последних не входит')
})

test('pickOne независим от отбора по содержанию: ключевые слова + один случайный', () => {
  const out = pickCommentCandidates(posts(10, 9, 8), { postFilter: 2, commentMode: 1, keywords: ['крипт'], pickOne: true })
  assert.equal(out.length, 1, 'раньше «по ключевым словам» всегда брал ВСЕ подходящие')
})

test('pickOne выключен — комментируются все подходящие', () => {
  const out = pickCommentCandidates(posts(10, 9, 8), { postFilter: 2, commentMode: 2, pickOne: false })
  assert.equal(out.length, 3)
})

test('старые задачи (commentMode 0) продолжают брать один случайный', () => {
  const out = pickCommentCandidates(posts(10, 9, 8), { postFilter: 2, commentMode: 0 })
  assert.equal(out.length, 1, 'совместимость: pickOne не задан, случайность вшита в commentMode 0')
})
