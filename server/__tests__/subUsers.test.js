import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { capModules, applyDirectGrants } from '../subAccess.js'

// ── §4.1 (MR-28): обрезка модулей суба до оплаченных ──
test('capModules: allow режется до оплаченных, deny сохраняется', () => {
  const perms = { modules: { 'neuro-commenting': 'allow', mailing: 'allow', warming: 'deny' }, blocks: {}, resources: {} }
  const capped = capModules(perms, ['neuro-commenting'])
  assert.deepEqual(capped.modules, { 'neuro-commenting': 'allow', warming: 'deny' }, 'остался только оплаченный allow + deny')
  // Исходный объект не мутируем.
  assert.equal(perms.modules.mailing, 'allow')
})

test('capModules: набор "all" или null — не режем; null permissions — как есть', () => {
  const perms = { modules: { a: 'allow', b: 'allow' }, blocks: {}, resources: {} }
  assert.deepEqual(capModules(perms, 'all').modules, { a: 'allow', b: 'allow' })
  assert.deepEqual(capModules(perms, null).modules, { a: 'allow', b: 'allow' })
  assert.equal(capModules(null, ['a']), null)
})

test('capModules: пустой оплаченный список — суб не получает ни одного модуля', () => {
  const perms = { modules: { a: 'allow', b: 'allow' }, blocks: {}, resources: {} }
  assert.deepEqual(capModules(perms, []).modules, {}, 'ничего не оплачено — доступа к модулям нет')
})

// ── §5.4 (MR-37): прямые выдачи аккаунтов/групп субу ──
test('applyDirectGrants: выдачи аккаунтов/групп вливаются как allow, deny не трогаем', () => {
  const perms = { modules: {}, blocks: {}, resources: { accounts: { a3: 'deny' }, accountGroups: {} } }
  const out = applyDirectGrants(perms, { accountIds: ['a1', 'a2', 'a3'], accountGroupIds: ['g1'] })
  assert.equal(out.resources.accounts.a1, 'allow')
  assert.equal(out.resources.accounts.a2, 'allow')
  assert.equal(out.resources.accounts.a3, 'deny', 'точечный deny из роли не перетираем выдачей')
  assert.equal(out.resources.accountGroups.g1, 'allow')
})

test('applyDirectGrants: без выдач и без прав — без изменений', () => {
  const perms = { modules: {}, blocks: {}, resources: { accounts: {}, accountGroups: {} } }
  assert.equal(applyDirectGrants(perms, {}), perms, 'нет выдач — тот же объект')
  assert.equal(applyDirectGrants(null, { accountIds: ['a1'] }), null, 'нет прав — нечего дополнять')
})

test('updateUser сохраняет выдачи аккаунтов/групп субу (файловый бэкенд)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subusers-grants-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?grants=' + Date.now())
  await u.listUsers()
  const boss = await u.createUser({ email: 'gowner@x.y', password: 'secret1' })
  const sub = await u.createUser({ email: 'gsub@x.y', password: 'secret1', parentId: boss.id })
  assert.deepEqual(sub.accountGroupIds, [], 'по умолчанию выдач нет')
  const upd = await u.updateUser(sub.id, { accountGroupIds: ['grp_1', 'grp_1', ''], accountIds: ['acc_9'] })
  assert.deepEqual(upd.accountGroupIds, ['grp_1'], 'нормализованы (уникальные, без пустых)')
  assert.deepEqual(upd.accountIds, ['acc_9'])
  const reread = await u.getUser(sub.id)
  assert.deepEqual(reread.accountGroupIds, ['grp_1'], 'сохранилось на диск')
  delete process.env.USERS_FILE
})

// ── §4.1 (MR-28): зависимые статусы владельца и субов (файловый бэкенд) ──
test('isBlockedByOwner + listSubs: блокировка владельца каскадит на субов', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subusers-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?subs=' + Date.now())
  await u.listUsers() // сид

  const boss = await u.createUser({ email: 'owner@x.y', password: 'secret1', name: 'Владелец' })
  const sub = await u.createUser({ email: 'sub@x.y', password: 'secret1', name: 'Суб', parentId: boss.id })
  const subsub = await u.createUser({ email: 'subsub@x.y', password: 'secret1', name: 'Суб-суб', parentId: sub.id })

  // listSubs — только прямые дети владельца.
  const subs = await u.listSubs(boss.id)
  assert.deepEqual(subs.map((x) => x.id), [sub.id], 'у владельца один прямой суб')

  // Пока все активны — никто не заблокирован владельцем.
  assert.equal(await u.isBlockedByOwner(boss), false, 'у владельца нет владельца')
  assert.equal(await u.isBlockedByOwner(sub), false)
  assert.equal(await u.isBlockedByOwner(subsub), false)

  // Отключаем владельца — суб и суб-суб блокируются по цепочке.
  await u.updateUser(boss.id, { active: false })
  assert.equal(await u.isBlockedByOwner(await u.getUser(sub.id)), true, 'суб заблокирован владельцем')
  assert.equal(await u.isBlockedByOwner(await u.getUser(subsub.id)), true, 'суб-суб заблокирован вверх по цепочке')

  // Возвращаем владельца — блокировка по владельцу снимается.
  await u.updateUser(boss.id, { active: true })
  assert.equal(await u.isBlockedByOwner(await u.getUser(sub.id)), false, 'владелец включён — суб снова доступен')

  delete process.env.USERS_FILE
})

// ── §4.1 (MR-29): контекст автора запроса для owner-scoping ──
test('requesterContext: нет заголовка → дев/полный доступ; неизвестный → blocked; владелец → не админ', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subusers-ctx-'))
  process.env.USERS_FILE = path.join(dir, 'users.json')
  const u = await import('../users.js?ctx=' + Date.now())
  const { requesterContext } = await import('../lib/accessGuard.js?ctx=' + Date.now())
  await u.listUsers() // сид
  const boss = await u.createUser({ email: 'ctxowner@x.y', password: 'secret1', name: 'Владелец', roleIds: [] })

  const req = (id) => ({ header: (h) => (h.toLowerCase() === 'x-user-id' ? id : undefined) })

  const noSession = await requesterContext(req(undefined))
  assert.equal(noSession.noSession, true)
  assert.equal(noSession.isAdmin, true, 'без сессии — дев/полный доступ')

  const unknown = await requesterContext(req('usr_ghost'))
  assert.equal(unknown.blocked, true, 'неизвестный автор — отказать')

  const owner = await requesterContext(req(boss.id))
  assert.equal(owner.blocked, false)
  assert.equal(owner.isAdmin, false, 'обычный владелец — не админ')
  assert.equal(owner.id, boss.id)

  delete process.env.USERS_FILE
})
