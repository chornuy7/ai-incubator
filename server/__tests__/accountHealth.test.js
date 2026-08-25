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
