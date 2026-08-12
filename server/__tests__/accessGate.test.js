/**
 * Замок «доступ отключён»: отключённый профиль не должен видеть ничего, кроме своего
 * состояния, оплаты и поддержки. Проверяем именно поведение middleware, а не разметку.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'access-gate-'))
process.env.USERS_FILE = path.join(tmp, 'users.json')

const { accessGate } = await import('../lib/accessGate.js')
const { createUser, updateUser } = await import('../users.js')

/** Мини-обвязка вокруг express-middleware: возвращает, что он сделал. */
async function run(userId, url, method = 'GET') {
  const req = {
    method,
    url,
    originalUrl: url,
    headers: userId ? { 'x-user-id': userId } : {},
    header(name) { return this.headers[String(name).toLowerCase()] },
  }
  let nexted = false
  let status = 0
  let body = null
  const res = {
    status(code) { status = code; return this },
    json(payload) { body = payload; return this },
  }
  await accessGate(req, res, () => { nexted = true })
  return { nexted, status, body }
}

const active = await createUser({ email: 'active@x.y', name: 'Активный', roleId: 'role_viewer', password: 'pass12345' })
const blocked = await createUser({ email: 'blocked@x.y', name: 'Отключённый', roleId: 'role_viewer', password: 'pass12345' })
await updateUser(blocked.id, { active: false })

test('гость (без сессии) проходит — им занимается sessionGuard', async () => {
  const r = await run('', '/api/accounts')
  assert.equal(r.nexted, true)
})

test('активный пользователь проходит куда угодно', async () => {
  const r = await run(active.id, '/api/tg/accounts')
  assert.equal(r.nexted, true, 'активному доступ закрывать не за что')
})

test('отключённый получает 403 на рабочие данные', async () => {
  for (const url of ['/api/tg/accounts', '/api/modules/tasks', '/api/leads', '/api/proxies']) {
    const r = await run(blocked.id, url)
    assert.equal(r.nexted, false, `${url} не должен пропускаться`)
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'ACCESS_DISABLED')
  }
})

test('отключённому оставлены профиль, подписка и поддержка', async () => {
  for (const url of ['/api/session', '/api/me', '/api/subscription', '/api/tickets', '/api/health']) {
    const r = await run(blocked.id, url)
    assert.equal(r.nexted, true, `${url} должен остаться доступным: иначе человек не увидит причину и не сможет оплатить`)
  }
})

test('удалённый пользователь по старому токену закрыт (fail-closed)', async () => {
  const r = await run('usr_does_not_exist', '/api/tg/accounts')
  assert.equal(r.status, 403)
})

test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
