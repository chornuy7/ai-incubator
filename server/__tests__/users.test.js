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
