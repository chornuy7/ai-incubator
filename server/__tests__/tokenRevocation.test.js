/**
 * MR-203, вторая половина: выход гасит ВСЕ прежние токены человека.
 *
 * Чистка localStorage закрывает только тот браузер, где нажали «Выйти». Сам токен —
 * stateless HMAC со сроком в неделю, и до этой правки серверный выход его не отзывал:
 * любая уцелевшая копия строки оставалась рабочим ключом к аккаунту ещё до семи суток.
 *
 * Тесты поведенческие: гоняем настоящий `sessionGuard` с настоящими токенами.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SESSION_SECRET = 'тест-секрет-mr203' // без него замок выключен (дев-режим)

const { signSession, verifySession, SESSION_TTL_MS } = await import('../lib/session.js')
const { revokeTokensFor, isRevoked, ensureLoaded, __reset } = await import('../lib/tokenRevocation.js')
const { sessionGuard } = await import('../lib/authGuard.js')

/** Прогнать запрос через гвард: вернуть код ответа (0 = пропущен дальше). */
async function through(token, url = '/api/accounts') {
  const req = {
    method: 'GET', url, originalUrl: url, headers: {},
    header: (n) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined),
  }
  let code = 0
  let passed = false
  const res = { status: (c) => { code = c; return res }, json: () => res }
  await sessionGuard(req, res, () => { passed = true })
  return { code, passed, uid: req.headers['x-user-id'] }
}

test('момент выдачи выводится из срока токена', () => {
  const now = 1_700_000_000_000
  const t = signSession('usr_a', now)
  const s = verifySession(t, now + 1000)
  assert.equal(s.iat, now, 'iat обязан совпасть с моментом подписи')
  assert.equal(s.exp - s.iat, SESSION_TTL_MS, 'срок = выдача + TTL')
})

test('выход гасит токен, выданный ДО него', async () => {
  __reset()
  const now = Date.now()
  const старый = signSession('usr_x', now - 60_000)
  assert.equal((await through(старый)).uid, 'usr_x', 'до выхода токен рабочий')

  await revokeTokensFor('usr_x', now)

  const после = await through(старый)
  assert.equal(после.code, 401, [
    'Токен, выданный до выхода, обязан перестать приниматься.',
    'Иначе уцелевшая копия строки открывает аккаунт ещё до недели после «Выйти».',
  ].join('\n'))
  assert.equal(после.uid, undefined, 'личность по погашенному токену не подставляется')
})

test('новый вход после выхода работает', async () => {
  __reset()
  const now = Date.now()
  await revokeTokensFor('usr_y', now)
  const свежий = signSession('usr_y', now + 1) // зашёл заново
  assert.equal((await through(свежий)).uid, 'usr_y', 'после выхода человек должен спокойно войти снова')
  // Граница: токен, выданный в ту же миллисекунду, — это уже новый вход, не старый ключ.
  assert.equal(isRevoked('usr_y', now), false, 'токен ровно в момент выхода гасить нельзя')
  assert.equal(isRevoked('usr_y', now - 1), true, 'токен на миллисекунду раньше — уже погашен')
})

test('выход одного не гасит токены другого', async () => {
  __reset()
  const now = Date.now()
  const чужой = signSession('usr_b', now - 60_000)
  await revokeTokensFor('usr_a', now)
  assert.equal((await through(чужой)).uid, 'usr_b', 'выход одного человека не должен выкидывать остальных')
})

test('карта отзывов не требует БД в дев-режиме', async () => {
  __reset()
  await ensureLoaded() // без Supabase не должно ни падать, ни ходить в сеть
  assert.equal(isRevoked('usr_нет-такого', Date.now()), false, 'без отметки токен не отзывается')
})

test('роут выхода зовёт отзыв, а не только закрывает смену', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../usersRoutes.js', import.meta.url), 'utf8')
  const at = src.indexOf("usersRouter.post('/logout'")
  assert.ok(at > 0, 'роут выхода не найден')
  const body = src.slice(at, at + 900)
  assert.ok(/revokeTokensFor\(userId\)/.test(body), [
    'Выход обязан гасить прежние токены человека.',
    'Закрыть смену рабочего времени мало: токен остаётся валидным до недели.',
  ].join('\n'))
  assert.ok(body.indexOf('revokeTokensFor') < body.indexOf('clockOut'),
    'отзыв идёт первым: если упадёт clockOut, токен всё равно должен быть погашен')
})
