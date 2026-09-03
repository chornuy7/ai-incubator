import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickDelay, effectiveProbability, isAccountRunnable,
  postMeetsMinWords, postMatchesKeywords, extractFloodSeconds, mapTelegramError, interruptibleSleep, pickJoinDelay, MIN_JOIN_DELAY_SEC } from '../lib/protection.js'

test('pickDelay: держится в пределах [lo, hi], пол 5с', () => {
  for (let i = 0; i < 50; i++) {
    const v = pickDelay(10, 20, 1)
    assert.ok(v >= 10 && v <= 20)
  }
  // mul=0 → пол 5с
  assert.equal(pickDelay(10, 20, 0), 5)
  // to не задан → берём from
  const v = pickDelay(8, undefined, 1)
  assert.ok(v >= 8 && v <= 8)
})

test('effectiveProbability: ИИ-защита срезает вероятность по уровню', () => {
  assert.equal(effectiveProbability(80, false, 0), 80) // без защиты — как есть
  assert.equal(effectiveProbability(80, true, 0), 25) // консервативный ≤25
  assert.equal(effectiveProbability(80, true, 1), 45) // сбалансированный ≤45
  assert.equal(effectiveProbability(80, true, 2), 80) // агрессивный не режет
  assert.equal(effectiveProbability(10, true, 0), 10) // ниже потолка — как есть
})

test('isAccountRunnable: рабочие vs заблокированные статусы', () => {
  assert.equal(isAccountRunnable('active'), true)
  assert.equal(isAccountRunnable('working'), true)
  assert.equal(isAccountRunnable('warming'), true)
  for (const s of ['quarantine', 'spamblock', 'invalid', 'frozen', 'reauth', 'floodwait', 'pause']) {
    assert.equal(isAccountRunnable(s), false, s)
  }
})

test('postMeetsMinWords / postMatchesKeywords', () => {
  assert.equal(postMeetsMinWords('one two three', 0), true) // нет требования
  assert.equal(postMeetsMinWords('one two', 3), false)
  assert.equal(postMeetsMinWords('one two three', 3), true)
  assert.equal(postMatchesKeywords('любой текст', []), true) // нет ключей → любой
  assert.equal(postMatchesKeywords('Купить КРИПТУ дёшево', ['крипт']), true) // регистронезависимо
  assert.equal(postMatchesKeywords('про погоду', ['крипт', 'акци']), false)
})

test('extractFloodSeconds: из seconds и из текста', () => {
  assert.equal(extractFloodSeconds({ seconds: 42 }), 42)
  assert.equal(extractFloodSeconds({ errorMessage: 'FLOOD_WAIT_30' }), 30)
  assert.equal(extractFloodSeconds({ message: 'A wait of 15 seconds is required' }), 15)
  assert.equal(extractFloodSeconds({}), 0)
  assert.equal(extractFloodSeconds(null), 0)
})

test('mapTelegramError: понятные сообщения', () => {
  assert.match(mapTelegramError({ errorMessage: 'PEER_NOT_FOUND' }), /Контакт не найден/)
  assert.match(mapTelegramError({ message: 'NO_DISCUSSION' }), /обсуждения/)
  assert.match(mapTelegramError({ errorMessage: 'CHANNEL_PRIVATE' }), /Приватный/)
  assert.equal(mapTelegramError({}), 'Ошибка Telegram')
})

test('interruptibleSleep: прерывается по shouldStop за ~1 чанк (#6)', async () => {
  let stop = false
  setTimeout(() => { stop = true }, 30)
  const t0 = Date.now()
  const interrupted = await interruptibleSleep(5000, () => stop, 20) // чанк 20мс
  const dt = Date.now() - t0
  assert.equal(interrupted, true) // прервали
  assert.ok(dt < 500, `должно прерваться быстро, а не ждать 5с (было ${dt}мс)`)
})

test('interruptibleSleep: без стопа спит полностью', async () => {
  const t0 = Date.now()
  const interrupted = await interruptibleSleep(60, () => false, 20)
  assert.equal(interrupted, false)
  assert.ok(Date.now() - t0 >= 55)
})

test('pickJoinDelay: множитель не может срезать паузу вступления ниже порога', () => {
  // Прогон 21.07: уровень «агрессивный» + пресет «мин» дали множитель ~0.35,
  // и заданные 90–240с превратились в 32с. Итог — FloodWait и карантин.
  for (const mul of [0.1, 0.2, 0.35, 0.5]) {
    const d = pickJoinDelay(90, 240, mul)
    assert.ok(d >= MIN_JOIN_DELAY_SEC, `множитель ${mul} дал ${d}с — ниже порога ${MIN_JOIN_DELAY_SEC}с`)
  }
})

test('pickJoinDelay: когда пауза и так большая — не трогаем', () => {
  const d = pickJoinDelay(300, 600, 1)
  assert.ok(d >= 300 && d <= 600, `ожидали 300–600, получили ${d}`)
})

test('бан В ЧАТЕ не равен бану аккаунта — ни в тексте, ни в политике', async () => {
  // 18.08: в логах задачи стояло «Аккаунт забанен», и мы решили, что профиль сожжён.
  // Проверка живьём показала обратное: аккаунт входит, читает канал, ограничений
  // Telegram нет — ему просто запрещено писать в одном конкретном чате.
  const { mapTelegramError } = await import('../lib/protection.js')

  const inChannel = mapTelegramError({ errorMessage: 'USER_BANNED_IN_CHANNEL' })
  assert.match(inChannel, /в этом чате/i)
  assert.doesNotMatch(inChannel, /^Аккаунт заблокирован/, 'нельзя списывать живой аккаунт')

  const account = mapTelegramError({ errorMessage: 'USER_DEACTIVATED' })
  assert.match(account, /Аккаунт заблокирован/)
})

test('политика бана не наказывает аккаунт за запрет в одном чате', async () => {
  // Цена ошибки: при политике «карантин» один строгий чат выводил бы здоровый аккаунт
  // из работы целиком. На парке в сотни профилей так выкашивается половина пула.
  const src = await import('node:fs/promises')
  const code = await src.readFile(new URL('../lib/accountRunner.js', import.meta.url), 'utf8')
  const line = code.split('\n').find((l) => l.includes('const isBan ='))
  assert.match(line, /!bannedHere/, 'запрет в чате обязан быть исключён из правила бана')
})

test('коды реакций объясняют себя: реакции для админов, запрещённая эмодзи (26.08)', async () => {
  // Прогон массовых реакций 26.08: в логах стоял сырой «CHAT_ADMIN_REQUIRED» — ни что
  // случилось, ни что делать. А USER_BANNED_IN_CHANNEL говорил про «сообщение», хотя
  // модуль реакций ничего не пишет.
  const { mapTelegramError } = await import('../lib/protection.js')

  assert.match(mapTelegramError({ errorMessage: 'CHAT_ADMIN_REQUIRED' }), /только админам/i)
  assert.match(mapTelegramError({ errorMessage: 'REACTION_INVALID' }), /эмодзи/i)

  const banned = mapTelegramError({ errorMessage: 'USER_BANNED_IN_CHANNEL' })
  assert.doesNotMatch(banned, /сообщени/i, 'на реакцию прилетает тот же код — слово «сообщение» вводит в заблуждение')
  assert.match(banned, /спамблок/i)
})
