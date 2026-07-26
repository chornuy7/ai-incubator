import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeRole, can, allowedFolderTargets, mergePermissions, userRoleIds, hasAdminRole, ALLOW, DENY, ADMIN_ROLE_ID } from '../roles.js'

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

test('userRoleIds/hasAdminRole: мульти-роль и обратная совместимость', () => {
  assert.deepEqual(userRoleIds({ roleIds: ['a', 'b', 'a'] }), ['a', 'b']) // дедуп
  assert.deepEqual(userRoleIds({ roleId: 'r1' }), ['r1']) // старый одиночный
  assert.deepEqual(userRoleIds({}), [])
  assert.equal(hasAdminRole(['x', ADMIN_ROLE_ID]), true)
  assert.equal(hasAdminRole(['x']), false)
})

test('mergePermissions(): суммирование прав нескольких ролей (union)', () => {
  const a = normalizeRole({ name: 'A', permissions: {
    modules: { warming: ALLOW },
    resources: { folders: { f1: ALLOW }, folderChannels: { f1: ['x', 'y'] }, timers: ALLOW },
  } })
  const b = normalizeRole({ name: 'B', permissions: {
    modules: { 'neuro-commenting': ALLOW },
    resources: { folders: { f1: ALLOW, f2: ALLOW }, folderChannels: { f1: ['z'] } },
  } })
  const m = mergePermissions([a, b])
  // модули объединяются
  assert.equal(m.modules.warming, ALLOW)
  assert.equal(m.modules['neuro-commenting'], ALLOW)
  // папки объединяются
  assert.equal(m.resources.folders.f1, ALLOW)
  assert.equal(m.resources.folders.f2, ALLOW)
  // каналы f1 складываются: x,y ∪ z
  assert.deepEqual([...m.resources.folderChannels.f1].sort(), ['x', 'y', 'z'])
  // f2 выдана без списка → нет ограничения (пусто = все)
  assert.equal(m.resources.folderChannels.f2, undefined)
  // timers: allow из A побеждает
  assert.equal(m.resources.timers, ALLOW)

  // «Вся папка» побеждает подсписок: A даёт f1 целиком, B — подсписком
  const whole = normalizeRole({ name: 'W', permissions: { resources: { folders: { f1: ALLOW } } } })
  const sub = normalizeRole({ name: 'S', permissions: { resources: { folders: { f1: ALLOW }, folderChannels: { f1: ['x'] } } } })
  const m2 = mergePermissions([whole, sub])
  assert.equal(m2.resources.folderChannels.f1, undefined) // ограничение снято
  assert.equal(m2.resources.searchTemplates, DENY)
})

test('sections: can() гейтит разделы, union объединяет, дефолт deny', () => {
  const admin = normalizeRole({ name: 'Admin' })
  admin.builtin = true; admin.id = ADMIN_ROLE_ID
  // админ — bypass даже для секций
  assert.equal(can(admin, 'section', '/panel/proxies'), true)

  const role = normalizeRole({ name: 'R', permissions: { sections: { '/panel': ALLOW, '/panel/proxies': DENY } } })
  assert.equal(can(role, 'section', '/panel'), true)
  assert.equal(can(role, 'section', '/panel/proxies'), false) // явный deny
  assert.equal(can(role, 'section', '/panel/logs'), false)    // нет в карте → deny
  assert.equal(can(null, 'section', '/panel'), false)

  // union: раздел разрешён, если его даёт хотя бы одна роль
  const a = normalizeRole({ name: 'A', permissions: { sections: { '/panel/tasks': ALLOW } } })
  const b = normalizeRole({ name: 'B', permissions: { sections: { '/panel/crm': ALLOW } } })
  const m = mergePermissions([a, b])
  assert.equal(m.sections['/panel/tasks'], ALLOW)
  assert.equal(m.sections['/panel/crm'], ALLOW)
  assert.equal(m.sections['/panel/proxies'], undefined) // не давали → нет
})

test('accounts: доступ на уровне аккаунта (R4) — can() + union, дефолт deny', () => {
  const admin = normalizeRole({ name: 'Admin' })
  admin.builtin = true; admin.id = ADMIN_ROLE_ID
  assert.equal(can(admin, 'account', 'acc_1'), true) // админ видит все

  const role = normalizeRole({ name: 'R', permissions: { resources: { accounts: { acc_1: ALLOW, acc_2: DENY } } } })
  assert.equal(can(role, 'account', 'acc_1'), true)
  assert.equal(can(role, 'account', 'acc_2'), false) // явный deny
  assert.equal(can(role, 'account', 'acc_9'), false) // нет в карте → deny (нужен явный доступ)
  assert.equal(can(null, 'account', 'acc_1'), false)

  // union: аккаунт виден, если его дала хотя бы одна роль
  const a = normalizeRole({ name: 'A', permissions: { resources: { accounts: { acc_1: ALLOW } } } })
  const b = normalizeRole({ name: 'B', permissions: { resources: { accounts: { acc_2: ALLOW } } } })
  const m = mergePermissions([a, b])
  assert.equal(m.resources.accounts.acc_1, ALLOW)
  assert.equal(m.resources.accounts.acc_2, ALLOW)
  assert.equal(m.resources.accounts.acc_3, undefined)
})

test('CRUD ролей на изолированном файле + сид по умолчанию', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const r = await import('../roles.js?crud=' + Date.now())

  // Первое чтение сидит дефолты: Администратор + Оператор + Модератор + Sales + Viewer.
  const seed = await r.listRoles()
  assert.equal(seed.length, 5)
  assert.ok(seed.some((x) => x.id === r.ADMIN_ROLE_ID && x.builtin))
  assert.deepEqual(
    seed.filter((x) => x.isTemplate).map((x) => x.id).sort(),
    ['role_moderator', 'role_operator', 'role_sales', 'role_viewer'],
  )

  const created = await r.createRole({ name: 'Контент', permissions: { modules: { 'neuro-commenting': 'allow' } } })
  assert.ok(created.id.startsWith('role_'))
  assert.equal(created.builtin, false)
  assert.equal((await r.listRoles()).length, 6)

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
  assert.equal((await r.listRoles()).length, 5)

  delete process.env.ROLES_FILE
})

test('createRole без имени — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const r = await import('../roles.js?noname=' + Date.now())
  await assert.rejects(() => r.createRole({ permissions: {} }), /название/i)
  delete process.env.ROLES_FILE
})

test('§12 accountGroups доживают до фронта: can() знает kind и mergePermissions их не теряет', () => {
  const r = normalizeRole({ name: 'Групповая', permissions: {
    resources: { accountGroups: { grp_ru: ALLOW, grp_ua: 'нет' } },
  } })
  // can() умеет отвечать про группу (без этого kind всегда падал в default → false)
  assert.equal(can(r, 'accountGroup', 'grp_ru'), true)
  assert.equal(can(r, 'accountGroup', 'grp_ua'), false)
  assert.equal(can(r, 'accountGroup', 'нет-такой'), false)

  // регрессия: mergePermissions роняла accountGroups целиком — доступ на группу
  // сохранялся в роли, но до клиента не доезжал, и §12 не работал вообще
  const other = normalizeRole({ name: 'Другая', permissions: {
    resources: { accountGroups: { grp_kz: ALLOW } },
  } })
  const m = mergePermissions([r, other])
  assert.equal(m.resources.accountGroups.grp_ru, ALLOW)
  assert.equal(m.resources.accountGroups.grp_kz, ALLOW) // union по ролям
  // Раньше здесь ожидался undefined: запреты в mergePermissions не проходили вовсе.
  // Из-за этого точечный запрет не работал в принципе — он терялся при объединении
  // и до клиента не доезжал (прогон 21–22.07, тест 7.4). Теперь запрет доживает.
  assert.equal(m.resources.accountGroups.grp_ua, 'deny')
})

test('7.4 точечный запрет сильнее группового разрешения и переживает объединение ролей', () => {
  const allowRole = normalizeRole({ name: 'Доступ', permissions: {
    resources: { accounts: { acc_1: ALLOW, acc_2: ALLOW } },
  } })
  const denyRole = normalizeRole({ name: 'Запрет', permissions: {
    resources: { accounts: { acc_2: 'deny' } },
  } })

  // Порядок ролей не должен влиять: deny выигрывает в обе стороны.
  for (const roles of [[allowRole, denyRole], [denyRole, allowRole]]) {
    const m = mergePermissions(roles)
    assert.equal(m.resources.accounts.acc_1, ALLOW, 'нетронутый аккаунт остаётся доступен')
    assert.equal(m.resources.accounts.acc_2, 'deny', 'явный запрет бьёт разрешение другой роли')
  }

  // «Не задано» — это не запрет: ключа просто нет, поведение нейтральное.
  assert.equal(mergePermissions([allowRole]).resources.accounts.acc_3, undefined)
})

/**
 * §8.1: право «чужие задачи» должно переживать объединение ролей. Без этого сервер
 * работал верно (читает роли напрямую), а фронт получал права БЕЗ него и молча
 * отказывал — расхождение, заметное только в интерфейсе.
 */
test('mergePermissions переносит allTasks', () => {
  const plain = { permissions: { resources: { allTasks: 'deny' } } }
  const lead = { permissions: { resources: { allTasks: 'allow' } } }
  assert.equal(mergePermissions([plain]).resources.allTasks, 'deny')
  assert.equal(mergePermissions([plain, lead]).resources.allTasks, 'allow', 'union: даёт любая роль')
  assert.equal(mergePermissions([]).resources.allTasks, 'deny', 'по умолчанию — deny')
})
