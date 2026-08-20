/**
 * Аудит 20.08: роуты, объявленные как `async (_req, res)`, отдавали данные всего
 * пространства (цели, кампании, группы, прокси с паролями, агенты, база каналов).
 *
 * Эти тесты держат разграничение: клиент видит только своё, админ — всё, легаси-записи
 * без владельца — только админу. Без них утечка вернулась бы молча при первом рефакторе.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Изолированное окружение с админом и обычным клиентом. */
async function setup(tag) {
  const dir = path.join(os.tmpdir(), `${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.DATA_DIR = dir
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const { createUser } = await import('../users.js')
  const { createRole, ADMIN_ROLE_ID } = await import('../roles.js')
  const plainRole = await createRole({ name: `Клиент ${tag}`, permissions: {} })
  const admin = await createUser({ email: `a-${tag}-${Date.now()}@t.io`, password: 'x12345', roleIds: [ADMIN_ROLE_ID] })
  const client = await createUser({ email: `c-${tag}-${Date.now()}@t.io`, password: 'x12345', roleIds: [plainRole.id] })
  const other = await createUser({ email: `o-${tag}-${Date.now()}@t.io`, password: 'x12345', roleIds: [plainRole.id] })
  return { dir, admin, client, other }
}

const req = (userId) => ({ header: (h) => (h.toLowerCase() === 'x-user-id' ? userId : undefined) })

test('ownedForRequest: клиент видит только свои записи, чужие — нет', async () => {
  const { client, other } = await setup('own')
  const { ownedForRequest } = await import('../lib/accessGuard.js')
  const rows = [
    { id: 'a', userId: client.id },
    { id: 'b', userId: other.id },
    { id: 'c', userId: client.id },
  ]
  const mine = await ownedForRequest(req(client.id), rows)
  assert.deepEqual(mine.map((r) => r.id), ['a', 'c'], 'чужая запись b не должна попасть в выдачу')
})

test('ownedForRequest: админ видит всё, включая чужое и легаси без владельца', async () => {
  const { admin, client } = await setup('own-admin')
  const { ownedForRequest } = await import('../lib/accessGuard.js')
  const rows = [{ id: 'a', userId: client.id }, { id: 'legacy' }]
  const seen = await ownedForRequest(req(admin.id), rows)
  assert.equal(seen.length, 2)
})

test('ownedForRequest: записи БЕЗ владельца (легаси) клиенту не отдаются', async () => {
  const { client } = await setup('own-legacy')
  const { ownedForRequest } = await import('../lib/accessGuard.js')
  const rows = [{ id: 'legacy1' }, { id: 'legacy2', userId: null }, { id: 'mine', userId: client.id }]
  const seen = await ownedForRequest(req(client.id), rows)
  assert.deepEqual(seen.map((r) => r.id), ['mine'], 'чужие/ничьи записи клиент видеть не должен')
})

test('ownedForRequest: отключённый пользователь не видит ничего (fail-closed)', async () => {
  const { client } = await setup('own-blocked')
  const { updateUser } = await import('../users.js')
  await updateUser(client.id, { active: false })
  const { ownedForRequest } = await import('../lib/accessGuard.js')
  const seen = await ownedForRequest(req(client.id), [{ id: 'a', userId: client.id }])
  assert.deepEqual(seen, [], 'заблокированному не отдаём даже его собственные записи')
})

test('ownedForRequest: свой ключ владельца можно задать (прокси хранят ownerId)', async () => {
  const { client, other } = await setup('own-key')
  const { ownedForRequest } = await import('../lib/accessGuard.js')
  const proxies = [
    { id: 'p1', ownerId: client.id, password: 'secret' },
    { id: 'p2', ownerId: other.id, password: 'nope' },
    { id: 'p3', password: 'legacy' }, // без владельца — только админу
  ]
  const seen = await ownedForRequest(req(client.id), proxies, (p) => p.ownerId)
  assert.deepEqual(seen.map((p) => p.id), ['p1'], 'чужие креды не должны попадать в выдачу')
})

test('ownerScopeForRequest: без сессии (дев) — доступ ко всему; админ — all', async () => {
  const { admin, client } = await setup('scope')
  const { ownerScopeForRequest } = await import('../lib/accessGuard.js')
  assert.equal((await ownerScopeForRequest(req(undefined))).all, true, 'дев-режим без заголовка')
  assert.equal((await ownerScopeForRequest(req(admin.id))).all, true)
  const cs = await ownerScopeForRequest(req(client.id))
  assert.equal(cs.all, false)
  assert.equal(cs.ownerId, client.id, 'без владельца-родителя клиент — сам себе пространство')
})

test('channelsForRequest: клиент видит каналы, найденные ЕГО прогонами; чужие — нет', async () => {
  const { admin, client } = await setup('chan')
  const { channelsForRequest } = await import('../lib/accessGuard.js')
  // sources пишет воркер парсера как `parse:<taskId>`; владельца задачи резолвим из стора
  // модулей. В изолированном тесте сторов нет → карта пустая: клиент не видит ничего,
  // админ видит всё. Это и есть fail-closed поведение, которое важно зафиксировать.
  const channels = [
    { id: 'ch1', sources: ['parse:pg_mine'] },
    { id: 'ch2', sources: [] },
  ]
  assert.equal((await channelsForRequest(req(admin.id), channels)).length, 2, 'админ видит всю базу')
  assert.deepEqual(await channelsForRequest(req(client.id), channels), [], 'чужие прогоны клиенту не видны')
})
