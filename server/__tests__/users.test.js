import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashPassword, verifyPassword, publicUser } from '../users.js'

test('hashPassword/verifyPassword: корректный и неверный пароль', () => {
  const stored = hashPassword('11111111')
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/) // salt:hash
  assert.equal(verifyPassword('11111111', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
  assert.equal(verifyPassword('11111111', 'мусор'), false)
})

test('publicUser убирает хэш пароля', () => {
  const pub = publicUser({ id: 'u1', email: 'a@b.c', passwordHash: 'secret:hash' })
  assert.equal(pub.email, 'a@b.c')
  assert.equal('passwordHash' in pub, false)
})

test('CRUD + authenticate на изолированном файле, сид тестового юзера', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'users-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?crud=' + Date.now())

  // Сид: админ + тестовый модератор (запрошен заказчиком).
  const seed = await u.listUsers()
  assert.equal(seed.length, 2)
  const test = seed.find((x) => x.email === 'ya.lonk777@gmail.com')
  assert.ok(test, 'тестовый юзер засеян')
  assert.equal(test.roleId, 'role_moderator')

  // Аутентификация тестового юзера его паролем.
  const ok = await u.authenticate('ya.lonk777@gmail.com', '11111111')
  assert.ok(ok)
  assert.equal(ok.email, 'ya.lonk777@gmail.com')
  assert.equal('passwordHash' in ok, false) // без секрета
  assert.equal(await u.authenticate('ya.lonk777@gmail.com', 'нет'), null)
  assert.equal(await u.authenticate('ghost@x.y', '11111111'), null)

  // Создание/обновление/удаление.
  const created = await u.createUser({ email: 'New@Mail.RU', name: 'Опер', password: 'secret1', roleId: 'role_moderator' })
  assert.equal(created.email, 'new@mail.ru') // нормализация e-mail
  await assert.rejects(() => u.createUser({ email: 'new@mail.ru', password: 'secret1' }), /уже есть/i)
  await assert.rejects(() => u.createUser({ email: 'x@y.z', password: '123' }), /минимум 6/i)
  // Серверная валидация (не только фронт): формат e-mail, потолок пароля и имени.
  await assert.rejects(() => u.createUser({ email: 'мусор', password: 'secret1' }), /Некорректный e-mail/i)
  await assert.rejects(() => u.createUser({ email: 'a@b.co', password: 'x'.repeat(201) }), /слишком длинный/i)
  await assert.rejects(() => u.createUser({ email: 'a@b.co', password: 'secret1', name: 'я'.repeat(121) }), /Имя слишком длинное/i)

  const upd = await u.updateUser(created.id, { active: false })
  assert.equal(upd.active, false)
  assert.equal(await u.authenticate('new@mail.ru', 'secret1'), null) // отключён — вход закрыт

  await assert.rejects(() => u.deleteUser('usr_admin'), /администратор/i)
  assert.equal(await u.deleteUser(created.id), true)
  assert.equal((await u.listUsers()).length, 2)

  delete process.env.USERS_FILE
})

test('§10.4: вложенные юзеры — родитель, защита от циклов, осиротение при удалении', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'users-nested-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?nested=' + Date.now())
  await u.listUsers() // сид

  const boss = await u.createUser({ email: 'boss@x.y', password: 'secret1', name: 'Админ-клиент' })
  const sub = await u.createUser({ email: 'sub@x.y', password: 'secret1', name: 'Сотрудник', parentId: boss.id })
  assert.equal(sub.parentId, boss.id, 'суб-юзер вложен под своего админа')

  // Несуществующий родитель — отказ.
  await assert.rejects(() => u.createUser({ email: 'q@x.y', password: 'secret1', parentId: 'usr_ghost' }), /не найден/i)

  // Нельзя стать родителем себе.
  await assert.rejects(() => u.updateUser(sub.id, { parentId: sub.id }), /сам себе/i)

  // Цикл: boss под sub, при том что sub уже под boss — запрещено.
  await assert.rejects(() => u.updateUser(boss.id, { parentId: sub.id }), /цикл/i)

  // Снять родителя.
  const freed = await u.updateUser(sub.id, { parentId: null })
  assert.equal(freed.parentId, null)

  // Удаление админа осиротляет суб-юзеров (as `on delete set null`), не удаляет их.
  await u.updateUser(sub.id, { parentId: boss.id })
  assert.equal(await u.deleteUser(boss.id), true)
  const subAfter = await u.getUser(sub.id)
  assert.ok(subAfter, 'суб-юзер не удалён вместе с админом')
  assert.equal(subAfter.parentId, null, 'ссылка на удалённого админа снята')

  delete process.env.USERS_FILE
})

test('регистрация: явный пустой roleIds → БЕЗ доступа, пока админ не выдал', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'users-reg-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?reg=' + Date.now())

  // Самостоятельная регистрация — роли пустые явно: доступа нет.
  const guest = await u.createUser({ email: 'tester@focus.io', password: 'secret1', name: 'Тестер', roleIds: [] })
  assert.deepEqual(guest.roleIds, [], 'ролей нет')
  assert.equal(guest.roleId, '', 'первичной роли нет')
  assert.equal(guest.active, true, 'войти может, но доступа к модулям нет')

  // Админ создаёт оператора БЕЗ указания роли — тут дефолт «Модератор» остаётся.
  const oper = await u.createUser({ email: 'oper@x.y', password: 'secret1' })
  assert.deepEqual(oper.roleIds, ['role_moderator'], 'поведение админ-формы не изменилось')

  delete process.env.USERS_FILE
})

/**
 * Владелец 24.08 отключил сам себя и потерял админку.
 *
 * Админка и панель — это РАЗНЫЕ сессии, но ОДИН пользователь: «админ» это роль на его
 * записи, отдельной админской базы нет. Поэтому `active:false` на себе закрывает обе
 * зоны сразу, и вернуть доступ из интерфейса уже нечем — только SQL в базе.
 */
test('отключённый профиль закрывает и панель, и админку — админ перестаёт быть админом', async () => {
  const { createUser, updateUser } = await import('../users.js')
  const { ADMIN_ROLE_ID } = await import('../roles.js')
  const { requesterContext } = await import('../lib/accessGuard.js')
  const mockReq = (id) => ({ header: (h) => (h.toLowerCase() === 'x-user-id' ? id : undefined), path: '/' })

  const boss = await createUser({ email: `self${Date.now()}@t.io`, password: 'x12345', roleIds: [ADMIN_ROLE_ID] })
  const before = await requesterContext(mockReq(boss.id))
  assert.equal(before.isAdmin, true, 'до отключения это админ')

  await updateUser(boss.id, { active: false })
  const after = await requesterContext(mockReq(boss.id))
  assert.equal(after.blocked, true)
  assert.equal(after.isAdmin, false, 'роль админа не спасает — профиль выключен')
  assert.equal(after.isSupport, false)
})
