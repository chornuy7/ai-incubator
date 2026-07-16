import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moduleAccessGuard, moduleKeyFromModulesPath } from '../lib/accessGuard.js'

test('moduleKeyFromModulesPath: первый сегмент, tasks → null', () => {
  assert.equal(moduleKeyFromModulesPath({ path: '/neuro-commenting/tasks' }), 'neuro-commenting')
  assert.equal(moduleKeyFromModulesPath({ path: '/mass-react/tasks/mr_1/stop' }), 'mass-react')
  assert.equal(moduleKeyFromModulesPath({ path: '/tasks' }), null) // список задач — не модуль
  assert.equal(moduleKeyFromModulesPath({ path: '/' }), null)
  assert.equal(moduleKeyFromModulesPath({ path: '' }), null)
})

function mockReq(headers, path) {
  return { header: (h) => headers[h.toLowerCase()], path }
}

test('moduleAccessGuard: fail-open без сессии и на не-модульном пути', async () => {
  const guard = moduleAccessGuard(moduleKeyFromModulesPath)

  // нет X-User-Id → пропускаем (дев/демо)
  let nexted = false
  await guard(mockReq({}, '/neuro-commenting/tasks'), {}, () => { nexted = true })
  assert.equal(nexted, true)

  // есть юзер, но путь не модульный (tasks) → key=null → next
  nexted = false
  await guard(mockReq({ 'x-user-id': 'u1' }, '/tasks'), {}, () => { nexted = true })
  assert.equal(nexted, true)
})

test('moduleAccessGuard: не роняет запрос при ошибке (fail-open)', async () => {
  const guard = moduleAccessGuard(() => { throw new Error('boom') })
  let nexted = false
  // res.status не должен вызываться — ошибка проглатывается в next()
  const res = { status: () => { throw new Error('should not be called') } }
  await guard(mockReq({ 'x-user-id': 'u1' }, '/x'), res, () => { nexted = true })
  assert.equal(nexted, true)
})
