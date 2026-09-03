/**
 * Подписанные сессии + глобальный guard (продакшн-замок входа).
 * Ключевое: без SESSION_SECRET замок ВЫКЛЮЧЕН (дев/тесты не ломаются),
 * с секретом — личность только из валидной подписи, чужое отклоняется.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const withSecret = async (secret, fn) => {
  const prev = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = secret
  try { await fn(await import('../lib/session.js?ss=' + Math.abs(hashStr(secret)))) }
  finally { if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev }
}
function hashStr(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

test('без секрета замок выключен, токен не выдаётся', async () => {
  const prev = process.env.SESSION_SECRET
  delete process.env.SESSION_SECRET
  const S = await import('../lib/session.js?nosecret=' + Date.now())
  assert.equal(S.authEnforced(), false)
  assert.equal(S.signSession('usr_1'), '')
  assert.equal(S.verifySession('что-угодно'), null)
  if (prev !== undefined) process.env.SESSION_SECRET = prev
})

test('с секретом: свой токен проходит, чужой/битый — нет', async () => {
  await withSecret('secret-A-' + Date.now(), (S) => {
    assert.equal(S.authEnforced(), true)
    const tok = S.signSession('usr_42')
    assert.ok(tok && tok.split('.').length === 3)
    assert.equal(S.verifySession(tok).userId, 'usr_42')
    // Подделка: тот же формат, но подпись не сойдётся.
    assert.equal(S.verifySession('dXNyXzk5.9999999999999.поддельная'), null)
    assert.equal(S.verifySession('мусор'), null)
    assert.equal(S.verifySession(''), null)
  })
})

test('токен, подписанный ДРУГИМ секретом, отклоняется', async () => {
  let foreign
  await withSecret('secret-one', (S) => { foreign = S.signSession('usr_7') })
  await withSecret('secret-two', (S) => {
    assert.equal(S.verifySession(foreign), null, 'чужой секрет — чужой токен')
  })
})

test('просроченный токен отклоняется', async () => {
  await withSecret('secret-exp', (S) => {
    const t0 = 1_000_000_000_000
    const tok = S.signSession('usr_x', t0)
    assert.equal(S.verifySession(tok, t0 + 1000).userId, 'usr_x') // свежий — ок
    assert.equal(S.verifySession(tok, t0 + S.SESSION_TTL_MS + 1), null) // просрочен
  })
})

// ── Глобальный guard ──
const mkReq = (over = {}) => ({
  method: over.method || 'GET',
  originalUrl: over.url || '/api/goals',
  url: over.url || '/api/goals',
  headers: { ...(over.headers || {}) },
  header(name) { return this.headers[String(name).toLowerCase()] },
})
const mkRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })

test('guard срезает присланный x-user-id — личность только из токена', async () => {
  const prev = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'guard-secret-1'
  const { sessionGuard } = await import('../lib/authGuard.js?g1=' + Date.now())
  const S = await import('../lib/session.js?g1=' + Date.now())
  // Клиент врёт, что он админ — заголовком. Токена нет → на проде это 401,
  // а x-user-id обязан быть срезан (не должен просочиться в RBAC).
  const req = mkReq({ headers: { 'x-user-id': 'usr_admin' } })
  const res = mkRes()
  let passed = false
  sessionGuard(req, res, () => { passed = true })
  assert.equal(passed, false, 'без токена на проде — не пускаем')
  assert.equal(res.code, 401)
  assert.equal(req.headers['x-user-id'], undefined, 'подставленный id срезан')
  if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev
})

test('guard: валидный токен → ставит доверенный x-user-id и пускает', async () => {
  const prev = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'guard-secret-2'
  const S = await import('../lib/session.js?g2=' + Date.now())
  const { sessionGuard } = await import('../lib/authGuard.js?g2=' + Date.now())
  const tok = S.signSession('usr_real')
  const req = mkReq({ headers: { authorization: 'Bearer ' + tok, 'x-user-id': 'usr_admin' } })
  const res = mkRes()
  let passed = false
  sessionGuard(req, res, () => { passed = true })
  assert.equal(passed, true)
  assert.equal(req.headers['x-user-id'], 'usr_real', 'id из токена, а не из подделки')
  if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev
})

test('guard: публичные пути открыты без входа (login/register/цены/health/v1)', async () => {
  const prev = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'guard-secret-3'
  const { sessionGuard } = await import('../lib/authGuard.js?g3=' + Date.now())
  const pub = [
    ['POST', '/api/users/login'],
    ['POST', '/api/users/register'],
    ['GET', '/api/subscription'],
    ['GET', '/api/health'],
    ['GET', '/api/v1/capabilities'],
  ]
  for (const [method, url] of pub) {
    const res = mkRes()
    let passed = false
    sessionGuard(mkReq({ method, url }), res, () => { passed = true })
    assert.equal(passed, true, `${method} ${url} должен быть публичным`)
  }
  // А защищённый — нет.
  const res = mkRes(); let passed = false
  sessionGuard(mkReq({ method: 'GET', url: '/api/tg/accounts' }), res, () => { passed = true })
  assert.equal(passed, false)
  assert.equal(res.code, 401)
  if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev
})

test('guard: api-ключ (aii_live_sk_) НЕ принимается как сессия', async () => {
  const prev = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'guard-secret-4'
  const { sessionGuard } = await import('../lib/authGuard.js?g4=' + Date.now())
  const req = mkReq({ headers: { authorization: 'Bearer aii_live_sk_deadbeef' } })
  const res = mkRes(); let passed = false
  sessionGuard(req, res, () => { passed = true })
  assert.equal(passed, false, 'ключ API — это /api/v1, а не сессия панели')
  assert.equal(res.code, 401)
  if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev
})

test('без секрета guard пропускает всё (дев-режим не сломан)', async () => {
  const prev = process.env.SESSION_SECRET
  delete process.env.SESSION_SECRET
  const { sessionGuard } = await import('../lib/authGuard.js?g5=' + Date.now())
  const res = mkRes(); let passed = false
  sessionGuard(mkReq({ url: '/api/tg/accounts' }), res, () => { passed = true })
  assert.equal(passed, true, 'локально/в тестах — как раньше')
  if (prev !== undefined) process.env.SESSION_SECRET = prev
})
