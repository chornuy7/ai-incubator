import test from 'node:test'
import assert from 'node:assert/strict'
import { pickReactionPost, normalizeLastPostsCount } from '../lib/reactionPick.js'

// Посты приходят свежими первыми — как их отдаёт getMessages.
const posts = (...ids) => ids.map((id) => ({ id }))
const never = () => false

test('глубина выборки: мусор и нули дают 3, всё вне 1–20 обрезается', () => {
  assert.equal(normalizeLastPostsCount(undefined), 3)
  assert.equal(normalizeLastPostsCount(0), 3)
  assert.equal(normalizeLastPostsCount('abc'), 3)
  assert.equal(normalizeLastPostsCount(2), 2)
  assert.equal(normalizeLastPostsCount(-5), 1)
  assert.equal(normalizeLastPostsCount(999), 20)
})

test('мониторинг: первый заход только ставит планку и не реагирует', () => {
  const r = pickReactionPost(posts(50, 49, 48), { mode: 0, lastPostsCount: 3, seenTop: undefined, reacted: never })
  assert.deepEqual(r, { action: 'baseline', topId: 50 })
})

test('мониторинг: реагируем только на посты выше планки, начиная со старшего по времени', () => {
  const r = pickReactionPost(posts(53, 52, 51, 50), { mode: 0, lastPostsCount: 3, seenTop: 50, reacted: never })
  assert.equal(r.action, 'react')
  // Из новых (51, 52, 53) берём самый ранний — иначе при частых постах ранние пропадут.
  assert.equal(r.post.id, 51)
})

test('мониторинг: новых постов нет — пропуск, а не реакция на старое', () => {
  const r = pickReactionPost(posts(50, 49), { mode: 0, lastPostsCount: 3, seenTop: 50, reacted: never })
  assert.deepEqual(r, { action: 'skip', reason: 'no-new' })
})

test('мониторинг: пост, уже отработанный этим аккаунтом, второй раз не берётся', () => {
  const r = pickReactionPost(posts(51, 50), { mode: 0, lastPostsCount: 3, seenTop: 50, reacted: (id) => id === 51 })
  assert.deepEqual(r, { action: 'skip', reason: 'no-new' })
})

test('существующие посты: выбор идёт ТОЛЬКО из N последних', () => {
  const chosen = new Set()
  for (let i = 0; i < 50; i++) {
    const r = pickReactionPost(posts(60, 59, 58, 57, 56), { mode: 1, lastPostsCount: 2, seenTop: undefined, reacted: never })
    assert.equal(r.action, 'react')
    chosen.add(r.post.id)
  }
  assert.deepEqual([...chosen].sort(), [59, 60])
})

test('существующие посты: планка не нужна — работает с первого захода', () => {
  const r = pickReactionPost(posts(60), { mode: 1, lastPostsCount: 3, seenTop: undefined, reacted: never })
  assert.equal(r.action, 'react')
  assert.equal(r.post.id, 60)
})

test('существующие посты: все N уже отработаны этим аккаунтом — пропуск', () => {
  const r = pickReactionPost(posts(60, 59, 58), { mode: 1, lastPostsCount: 3, seenTop: undefined, reacted: () => true })
  assert.deepEqual(r, { action: 'skip', reason: 'all-reacted' })
})

test('пустой канал не роняет выбор', () => {
  assert.deepEqual(
    pickReactionPost([], { mode: 0, lastPostsCount: 3, seenTop: 10, reacted: never }),
    { action: 'skip', reason: 'no-posts' },
  )
})
