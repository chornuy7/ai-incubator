/**
 * Живые сигналы канала и балл поверх них (правка владельца 26.08: «минимальный рейтинг
 * оставляем, просто свой скор сделать — насколько активный канал или чат»).
 *
 * Раньше «рейтинг» считался из одного числа подписчиков: у канала, брошенного год назад,
 * их столько же, сколько было в день последнего поста, — и он выглядел таким же хорошим,
 * как живой. Поэтому главное, что здесь проверяется, — что мёртвый канал проигрывает
 * живому, даже когда он крупнее.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelSignals, channelScore, isActive, detectLang, explainScore } from '../lib/channelScore.js'

const NOW = 1_800_000_000_000
const day = 86_400_000
const post = (daysAgo, extra = {}) => ({ date: Math.round((NOW - daysAgo * day) / 1000), message: 'текст', ...extra })

test('сигналы считаются по постам, дата приходит в секундах', () => {
  const s = channelSignals([post(0), post(2), post(10), post(40)], NOW)
  assert.equal(s.posts, 4)
  assert.equal(s.postsPerWeek, 2, 'сегодня и два дня назад')
  assert.equal(s.postsPerMonth, 3)
  assert.ok(s.daysSinceLastPost < 1, 'последний пост сегодня')
})

test('пустой канал — не активен, а не «неизвестно»', () => {
  const s = channelSignals([], NOW)
  assert.equal(s.daysSinceLastPost, null)
  assert.equal(isActive(s), false)
})

test('брошенный крупный канал проигрывает живому маленькому', () => {
  const мёртвый = channelScore({ members: 200_000, signals: channelSignals([post(200)], NOW) })
  const живой = channelScore({ members: 1_500, signals: channelSignals([post(0), post(1), post(2), post(3)], NOW) })
  assert.ok(живой > мёртвый, `живой ${живой} должен быть выше мёртвого ${мёртвый}`)
})

test('комментарии поднимают балл сильнее просмотров — они требуют усилия', () => {
  const posts = [post(0), post(1)]
  const сКомментами = channelScore({ members: 1000, signals: channelSignals(posts.map((p) => ({ ...p, replies: { replies: 8 } })), NOW) })
  const сПросмотрами = channelScore({ members: 1000, signals: channelSignals(posts.map((p) => ({ ...p, views: 300 })), NOW) })
  assert.ok(сКомментами > сПросмотрами)
})

test('балл не выходит за 0–10', () => {
  const макс = channelScore({ members: 5_000_000, signals: channelSignals(Array.from({ length: 30 }, (_, i) => ({ ...post(0), replies: { replies: 50 } })), NOW) })
  assert.ok(макс <= 10 && макс > 8)
  assert.equal(channelScore({}), 0)
})

test('язык определяется по буквам, а короткий текст не выдаётся за ответ', () => {
  assert.equal(detectLang(['Привет, это канал про криптовалюту и заработок']), 'ru')
  assert.equal(detectLang(['Привіт, це канал про криптовалюту і заробіток']), 'uk')
  assert.equal(detectLang(['Hello, this channel is about crypto trading']), 'en')
  assert.equal(detectLang(['ок']), null, 'по двум буквам язык не определяют')
  assert.equal(detectLang([]), null)
})

test('расшифровка балла называет причины, а не только цифру', () => {
  const s = channelSignals([post(0), post(1)], NOW)
  const text = explainScore({ members: 1200, signals: s })
  assert.match(text, /1200 подписчиков/)
  assert.match(text, /пост сегодня/)
})
