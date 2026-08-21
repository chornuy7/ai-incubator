import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Уточнение владельца 21.08: доступ субпользователя настраивается в ЕГО карточке —
 * «какой модуль показывать, какой нет, но только из тех, какие подписки куплены, и
 * дальше уже блоки». Отдельной страницы ролей у владельца нет: роль осталась механизмом
 * под капотом (гейт доступа умеет только роли), поэтому у каждого суба она своя и в
 * списке ролей не показывается.
 */

test('персональная роль помечается и переживает правку', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subacc-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const { createRole, updateRole, normalizeRole } = await import('../roles.js')

  assert.equal(normalizeRole({ name: 'x', personalFor: 'usr_1' }).personalFor, 'usr_1')
  assert.equal(normalizeRole({ name: 'x' }).personalFor, '', 'обычная роль ничья')

  const role = await createRole({
    name: 'Доступ · Иван', userId: 'own_1', personalFor: 'usr_1',
    permissions: { modules: { 'neuro-commenting': 'allow' } },
  })
  assert.equal(role.personalFor, 'usr_1')

  // Правка доступа не должна «отвязывать» роль от суба — иначе она всплывёт в общем
  // списке владельца и превратит его в свалку «Доступ · Иван», «Доступ · Пётр».
  const upd = await updateRole(role.id, { permissions: { modules: { 'mass-react': 'allow' } } })
  assert.equal(upd.personalFor, 'usr_1')
  assert.equal(upd.userId, 'own_1')
})

test('блоки живут только у разрешённых модулей', async () => {
  // Правило записи (usersRoutes): блок выключенного модуля не значит ничего, а в
  // хранилище копился бы мусором после каждой правки подписки.
  const modules = { 'neuro-commenting': 'allow', 'mass-react': 'deny' }
  const wanted = {
    'neuro-commenting:run': 'allow',
    'neuro-commenting:logs': 'deny',
    'mass-react:run': 'allow',       // модуль скрыт — блок не сохраняем
  }
  const kept = {}
  for (const [k, v] of Object.entries(wanted)) {
    const [mod] = k.split(':')
    if (modules[mod] === 'allow') kept[k] = v === 'allow' ? 'allow' : 'deny'
  }
  assert.deepEqual(kept, { 'neuro-commenting:run': 'allow', 'neuro-commenting:logs': 'deny' })
})

/**
 * Прод-специфичный баг (21.08): `roleToRow` не переносил `personalFor` в БД. На файлах
 * всё работало, а на Supabase роль сохранялась «ничьей» — при следующем сохранении
 * доступа она не находилась и создавалась заново: у суба размножались роли, а выданный
 * доступ пропадал. Метка теперь едет внутри `permissions` (jsonb сохраняется целиком).
 */
test('метка персональной роли переживает сохранение в любом хранилище', async () => {
  const { normalizeRole } = await import('../roles.js')

  // Из явного поля метка попадает и в права — там её увидит и БД, и файл.
  const fromField = normalizeRole({ name: 'Доступ · Иван', personalFor: 'usr_1' })
  assert.equal(fromField.personalFor, 'usr_1')
  assert.equal(fromField.permissions.personalFor, 'usr_1')

  // Обратный путь: роль пришла из БД, где метка лежит только внутри прав.
  const fromDb = normalizeRole({ name: 'Доступ · Иван', permissions: { personalFor: 'usr_1' } })
  assert.equal(fromDb.personalFor, 'usr_1', 'иначе роль считается ничьей и дублируется')

  // Обычная роль метки не получает — её не должно быть ни наверху, ни в правах.
  const plain = normalizeRole({ name: 'Оператор' })
  assert.equal(plain.personalFor, '')
  assert.equal(plain.permissions.personalFor, undefined)
})
