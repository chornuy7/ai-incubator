import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
/**
 * §8.1: каждый видит в Дашборде только свои запуски. Проверяем на чистых временных
 * файлах: раньше тест писал роли и пользователей в БОЕВЫЕ data/ — за десяток прогонов
 * набежало 22 мусорных роли и 33 юзера. Пути модулей резолвятся на импорте, поэтому
 * env выставляем ДО первого импорта, а не внутри теста.
 */
test('tasksForRequest: свои задачи — всем, чужие — только админу и роли allTasks', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs/promises')
  const dir = path.join(os.tmpdir(), `tasks-acl-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.DATA_DIR = dir
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  process.env.USERS_FILE = path.join(dir, 'users.json')

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

  // Ничего не оставляем в боевых данных: файлы теста живут в temp и удаляются.
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Отключённый сотрудник не должен проходить гейт модулей. Раньше здесь стоял
 * `next()` — то есть увольнение не закрывало доступ, хотя в соседних функциях
 * того же файла неизвестный пользователь был fail-closed.
 */
test('moduleAccessGuard: отключённый пользователь получает 403, а не проходит', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs/promises')
  const dir = path.join(os.tmpdir(), `guard-off-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.DATA_DIR = dir
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  process.env.USERS_FILE = path.join(dir, 'users.json')

  const { createUser, updateUser } = await import('../users.js')
  const { createRole } = await import('../roles.js')
  const role = await createRole({ name: 'Уволенный', permissions: { modules: { mailing: 'allow' } } })
  const user = await createUser({ email: `off${Date.now()}@t.io`, password: 'x12345', roleIds: [role.id] })
  await updateUser(user.id, { active: false })

  const guard = moduleAccessGuard(moduleKeyFromModulesPath)
  let status = 0
  const res = { status: (c) => { status = c; return { json: () => {} } } }
  let nexted = false
  await guard(mockReq({ 'x-user-id': user.id }, '/mailing/tasks'), res, () => { nexted = true })
  assert.equal(nexted, false, 'отключённый не должен проходить')
  assert.equal(status, 403)

  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Гейт модулей: роль И подписка (правка 18.08).
 *
 * Было: сервер смотрел только роль. Владелец без роли получал 403 на СВОИ оплаченные
 * модули, а неоплаченный модуль открывался по прямой ссылке любому, у кого роль его
 * разрешает. Обе оси теперь обязательны.
 */
test('владелец без роли работает со своими оплаченными модулями', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-owner-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  process.env.BALANCE_FILE = path.join(dir, 'balance.json')
  const { createUser } = await import('../users.js')
  const { setUserModules } = await import('../balance.js')
  const { moduleAccessGuard } = await import('../lib/accessGuard.js')

  const owner = await createUser({ email: 'guard.own@x.y', password: 'secret1', name: 'Владелец', roleIds: [] })
  await setUserModules(['warming'], owner.id, {})

  const guard = moduleAccessGuard(() => 'warming')
  let passed = false
  await guard({ header: () => owner.id }, { status: () => ({ json: () => {} }) }, () => { passed = true })
  assert.ok(passed, 'оплаченный модуль владельцу без роли открыт')

  const guardUnpaid = moduleAccessGuard(() => 'mailing')
  let denied = null
  await guardUnpaid(
    { header: () => owner.id },
    { status: (code) => ({ json: (body) => { denied = { code, body } } }) },
    () => { denied = 'passed' },
  )
  assert.equal(denied?.code, 403, 'неоплаченный модуль закрыт даже владельцу')
  assert.match(denied?.body?.error || '', /подписк/i, 'причина отказа — подписка, а не роль')
})
