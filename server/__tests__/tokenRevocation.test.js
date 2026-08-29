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

test('выход уходит на сервер ПОКА токен ещё на месте', async () => {
  /*
   * Живая проверка 29.08 показала, что `POST /api/users/logout` на проде не срабатывал
   * никогда: `logoutUser` первым вызывал clearToken(), и запрос уходил без Authorization,
   * а /logout не входит в публичный список — гвард отвечал 401, не доходя до роута.
   * Симптом на живой базе: 15 незакрытых смен из 18 (§8.1).
   */
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../../src/api/usersApi.ts', import.meta.url), 'utf8')
  const at = src.indexOf('export async function logoutUser')
  assert.ok(at > 0, 'logoutUser не найден')
  // Строки-комментарии выкидываем: в них самих упоминается clearToken(), и порядок СЛОВ
  // не должен подменять порядок ДЕЙСТВИЙ.
  const код = src.slice(at, at + 1400).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const запрос = код.indexOf("apiPost('/api/users/logout'")
  const снятие = код.indexOf('clearToken()')
  assert.ok(запрос > 0 && снятие > 0, 'в выходе должны быть и запрос, и снятие токена')
  assert.ok(запрос < снятие, [
    'Запрос выхода обязан уходить ДО снятия токена.',
    'Иначе он летит без Authorization, гвард отвечает 401, и сервер о выходе не узнаёт:',
    'ни отзыва токенов, ни закрытия смены рабочего времени.',
  ].join('\n'))
  assert.ok(/keepalive: true/.test(код), [
    'Сразу после выхода страница перезагружается.',
    'Без keepalive браузер отменяет запрос вместе с документом.',
  ].join('\n'))
})

test('выход нельзя устроить чужому человеку', async () => {
  // Роут брал userId из ТЕЛА запроса: любой вошедший мог прислать чужой id и погасить
  // чужие сессии. Личность должна браться из подписанного токена.
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../usersRoutes.js', import.meta.url), 'utf8')
  const at = src.indexOf("usersRouter.post('/logout'")
  const body = src.slice(at, at + 900)
  assert.ok(/req\.header\('x-user-id'\)/.test(body), 'кого гасим — из подписанного токена, а не из тела')
  const заголовок = body.indexOf("req.header('x-user-id')")
  const тело = body.indexOf('.userId')
  assert.ok(заголовок < тело || тело < 0, 'тело запроса — только запасной путь для дев-режима')
})

test('выход не публичный: чужие сессии гасить нельзя без входа', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../lib/authGuard.js', import.meta.url), 'utf8')
  const at = src.indexOf('const PUBLIC = [')
  // Режем до ЗАКРЫВАЮЩЕЙ скобки массива, а не до первой попавшейся: `]` встречается
  // внутри самих регулярок, и срез по ней покрыл бы только первую запись списка.
  const list = src.slice(at, src.indexOf('\n]', at))
  assert.ok(!/logout/.test(list), [
    'Выход обязан требовать входа.',
    'Публичный /logout дал бы любому гасить сессии кому угодно по чужому id.',
  ].join('\n'))
})
