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

/**
 * §8.1: каждый видит в Дашборде только свои запуски. Проверяем на реальных файлах
 * users/roles (тесты гоняются на временном DATA_DIR), потому что вся суть правила —
 * в связке «пользователь → его роли → право allTasks», а не в чистой функции.
 */
test('tasksForRequest: свои задачи — всем, чужие — только админу и роли allTasks', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs/promises')
  const dir = path.join(os.tmpdir(), `tasks-acl-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.DATA_DIR = dir

  const { createUser } = await import('../users.js')
  const { createRole, updateRole, ADMIN_ROLE_ID } = await import('../roles.js')
  const { tasksForRequest } = await import('../lib/accessGuard.js')

  const plain = await createRole({ name: 'Без чужих задач', permissions: {} })
  const lead = await createRole({ name: 'Тимлид', permissions: {} })
  await updateRole(lead.id, { permissions: { resources: { allTasks: 'allow' } } })

  const admin = await createUser({ email: `a${Date.now()}@t.io`, password: 'x12345', roleIds: [ADMIN_ROLE_ID] })
  const worker = await createUser({ email: `w${Date.now()}@t.io`, password: 'x12345', roleIds: [plain.id] })
  const boss = await createUser({ email: `b${Date.now()}@t.io`, password: 'x12345', roleIds: [lead.id] })

  const tasks = [
    { id: 't_own', userId: worker.id },
    { id: 't_other', userId: boss.id },
    { id: 't_legacy' }, // до того, как владельца стали запоминать
  ]
  const req = (id) => ({ header: (h) => (h.toLowerCase() === 'x-user-id' ? id : undefined) })
  const ids = (list) => list.map((t) => t.id)

  assert.deepEqual(ids(await tasksForRequest(req(worker.id), tasks)), ['t_own'], 'исполнитель видит только свою')
  assert.deepEqual(ids(await tasksForRequest(req(admin.id), tasks)), ['t_own', 't_other', 't_legacy'], 'админ — все')
  assert.deepEqual(ids(await tasksForRequest(req(boss.id), tasks)), ['t_own', 't_other', 't_legacy'], 'право allTasks — все')
  assert.deepEqual(ids(await tasksForRequest(req(undefined), tasks)), ['t_own', 't_other', 't_legacy'], 'без сессии — дев/демо')
  assert.deepEqual(await tasksForRequest(req('usr_несуществующий'), tasks), [], 'неизвестный юзер — ничего (fail-closed)')
})
