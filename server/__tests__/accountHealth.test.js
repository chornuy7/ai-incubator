/**
 * Р-19 (прогон 22.08): из двенадцати аккаунтов со статусом «активен» трое оказались
 * удалены Telegram, у одного сессия недействительна — а платформа узнавала об этом
 * только когда аккаунт брали в работу, то есть уже посреди задачи.
 *
 * Здесь сторожим САМОЕ ОПАСНОЕ место фоновой проверки: она обязана отличать беду
 * аккаунта от беды сети. Свалить живой аккаунт в «невалидный» из-за упавшего прокси —
 * значит выкосить пул на ровном месте, и это хуже, чем не заметить мёртвый.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyHealthError } from '../accountHealth.js'

test('беда аккаунта: удалён, забанен, сессия мертва — статус меняем', () => {
  assert.equal(classifyHealthError({ errorMessage: 'USER_DEACTIVATED' })?.status, 'invalid')
  assert.equal(classifyHealthError({ errorMessage: 'USER_DEACTIVATED_BAN' })?.status, 'invalid')
  assert.equal(classifyHealthError({ errorMessage: 'AUTH_KEY_UNREGISTERED' })?.status, 'reauth')
  assert.equal(classifyHealthError({ message: 'SESSION_REVOKED' })?.status, 'reauth')
  assert.equal(classifyHealthError({ errorMessage: 'FROZEN_METHOD_INVALID' })?.status, 'frozen')
})

test('беда сети: прокси, таймаут, FloodWait — аккаунт НЕ трогаем', () => {
  for (const msg of [
    'Прокси не отвечает',
    'RPC_TIMEOUT (25с)',
    'ECONNRESET',
    'ETIMEDOUT',
    'FLOOD_WAIT_420',
    'socks: connection refused',
  ]) {
    assert.equal(classifyHealthError({ message: msg }), null, `«${msg}» — это не вина аккаунта`)
  }
  assert.equal(classifyHealthError(null), null)
  assert.equal(classifyHealthError({}), null)
})

test('MR-291: спамблок с дефолтным сроком переспрашивается у @SpamBot', async () => {
  /*
   * Возврат по таймеру работает только там, где срок назвал сам бот. Дефолтные сутки —
   * догадка: проверка на живых аккаунтах 02.09 дала шесть из шести всё ещё в блоке спустя
   * пять дней после «истёкшего» срока.
   *
   * Переспрос живёт в проверке парка, а не в reconcile: reconcile бежит каждые пять минут
   * и в сеть не ходит, а здесь уже открыто подключение, есть лимит на заход и свой график.
   * Иначе 29 переспросов стали бы всплеском из 29 подключений разом — сам по себе
   * кластерный признак.
   */
  const src = fs.readFileSync(new URL('../accountHealth.js', import.meta.url), 'utf8')
  assert.match(src, /async function переспроситьСпамблок/)
  // Спрашиваем только тех, у кого срок наш, а не бота, и уже истёк.
  assert.match(src, /if \(meta\?\.statusUntilSource === 'spambot'\) return false/)
  assert.match(src, /if \(!срок \|\| Date\.now\(\) < срок\) return false/)
  // Чисто — снимаем статус; в блоке — продлеваем и запоминаем НАСТОЯЩИЙ срок, если назвали.
  assert.match(src, /code: 'SPAM_CLEARED'/)
  assert.match(src, /statusUntilSource: настоящий \? 'spambot' : 'default'/)
  // Вызов стоит после getMe: подключение уже проверено, второго не открываем.
  assert.ok(src.indexOf('await client.getMe()') < src.indexOf('await переспроситьСпамблок'))
})

test('MR-291: источник срока записывается при постановке спамблока', async () => {
  // Без этого признака «срок от Telegram» и «наша догадка» неотличимы, а решение о
  // возврате в работу принимается именно по нему.
  const runner = fs.readFileSync(new URL('../lib/accountRunner.js', import.meta.url), 'utf8')
  assert.match(runner, /const отБота = Number\(opts\.until\) > Date\.now\(\)/)
  assert.match(runner, /statusUntilSource: отБота \? 'spambot' : 'default'/)
})
