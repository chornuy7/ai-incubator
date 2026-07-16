import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeRole, can, allowedFolderTargets, ALLOW, DENY, ADMIN_ROLE_ID } from '../roles.js'

test('normalizeRole: дефолты и нормализация доступов', () => {
  const r = normalizeRole({
    name: '  Модер  ',
    isTemplate: 1,
    permissions: {
      modules: { 'neuro-commenting': 'allow', warming: 'что-то' },
      blocks: { 'neuro-commenting:run': 'allow' },
      resources: { folders: { fld_1: 'allow' }, timers: 'allow', searchTemplates: 'нет' },
    },
  })
  assert.equal(r.name, 'Модер') // trim
  assert.equal(r.isTemplate, true) // приведение к bool
  assert.equal(r.permissions.modules['neuro-commenting'], ALLOW)
  assert.equal(r.permissions.modules.warming, DENY) // мусор → deny
  assert.equal(r.permissions.blocks['neuro-commenting:run'], ALLOW)
  assert.equal(r.permissions.resources.folders.fld_1, ALLOW)
  assert.equal(r.permissions.resources.timers, ALLOW)
  assert.equal(r.permissions.resources.searchTemplates, DENY)
  assert.deepEqual(r.permissions.resources.channels, {}) // отсутствующее → пусто
})

test('can(): админ обходит проверки, остальные — по карте, дефолт deny', () => {
  const admin = { id: ADMIN_ROLE_ID, builtin: true, permissions: normalizeRole({}).permissions }
  assert.equal(can(admin, 'module', 'neuro-commenting'), true) // bypass, хотя карта пустая
  assert.equal(can(admin, 'channel', 'ch_x'), true)

  const mod = normalizeRole({
    permissions: {
      modules: { 'neuro-commenting': 'allow' },
      blocks: { 'neuro-commenting:run': 'allow' },
      resources: { channels: { ch_1: 'allow' }, timers: 'allow' },
    },
  })
  mod.id = 'role_x'
  assert.equal(can(mod, 'module', 'neuro-commenting'), true)
  assert.equal(can(mod, 'module', 'warming'), false) // нет в карте → deny
  assert.equal(can(mod, 'block', 'neuro-commenting:run'), true)
  assert.equal(can(mod, 'block', 'neuro-commenting:logs'), false)
  assert.equal(can(mod, 'channel', 'ch_1'), true)
  assert.equal(can(mod, 'channel', 'ch_2'), false)
  assert.equal(can(mod, 'timers'), true)
  assert.equal(can(mod, 'searchTemplates'), false)
  assert.equal(can(null, 'module', 'x'), false)
})

test('allowedFolderTargets(): выдача конкретных каналов внутри папки', () => {
  const admin = { id: ADMIN_ROLE_ID, builtin: true, permissions: {} }
  const all = ['@a', 'b', 'c']
  // Админ — всегда все каналы
  assert.deepEqual(allowedFolderTargets(admin, 'f1', all), all)
  // Права папок не заданы — не ограничиваем
  const open = normalizeRole({ name: 'x' })
  assert.deepEqual(allowedFolderTargets(open, 'f1', all), all)
  // Папка не выдана — пусто
  const other = normalizeRole({ name: 'x', permissions: { resources: { folders: { f2: ALLOW } } } })
  assert.deepEqual(allowedFolderTargets(other, 'f1', all), [])
  // Папка выдана без списка каналов — все каналы
  const whole = normalizeRole({ name: 'x', permissions: { resources: { folders: { f1: ALLOW } } } })
  assert.deepEqual(allowedFolderTargets(whole, 'f1', all), all)
  // Папка выдана со списком — пересечение (нормализация @/регистра)
  const subset = normalizeRole({ name: 'x', permissions: { resources: { folders: { f1: ALLOW }, folderChannels: { f1: ['A', 'c'] } } } })
  assert.deepEqual(allowedFolderTargets(subset, 'f1', all), ['@a', 'c'])
})

test('CRUD ролей на изолированном файле + сид по умолчанию', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const r = await import('../roles.js?crud=' + Date.now())

  // Первое чтение сидит §6-дефолты: Администратор + Оператор + Sales + Viewer.
  const seed = await r.listRoles()
  assert.equal(seed.length, 4)
  assert.ok(seed.some((x) => x.id === r.ADMIN_ROLE_ID && x.builtin))
  assert.deepEqual(
    seed.filter((x) => x.isTemplate).map((x) => x.id).sort(),
    ['role_operator', 'role_sales', 'role_viewer'],
  )

  const created = await r.createRole({ name: 'Контент', permissions: { modules: { 'neuro-commenting': 'allow' } } })
  assert.ok(created.id.startsWith('role_'))
  assert.equal(created.builtin, false)
  assert.equal((await r.listRoles()).length, 5)

  const upd = await r.updateRole(created.id, { name: 'Контент+', permissions: { modules: { 'neuro-commenting': 'deny' } } })
  assert.equal(upd.name, 'Контент+')
  assert.equal(upd.permissions.modules['neuro-commenting'], 'deny')

  // Права админа неизменяемы (bypass), но переименование проходит.
  const admin = await r.updateRole(r.ADMIN_ROLE_ID, { name: 'Главный', permissions: { modules: { warming: 'allow' } } })
  assert.equal(admin.name, 'Главный')
  assert.deepEqual(admin.permissions.modules, {}) // не изменились

  await assert.rejects(() => r.deleteRole(r.ADMIN_ROLE_ID), /встроенн/i)
  assert.equal(await r.deleteRole(created.id), true)
  assert.equal(await r.deleteRole('нет'), false)
  assert.equal((await r.listRoles()).length, 4)

  delete process.env.ROLES_FILE
})

test('createRole без имени — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const r = await import('../roles.js?noname=' + Date.now())
  await assert.rejects(() => r.createRole({ permissions: {} }), /название/i)
  delete process.env.ROLES_FILE
})
