import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeGroup, accountsOfGroups, groupsByAccount, isAccountAllowedViaGroups } from '../accountGroups.js'

test('§12 normalizeGroup: trim, дедуп аккаунтов, дефолты', () => {
  const g = normalizeGroup({ name: '  Прогрев RU  ', accountIds: ['a', 'a', ' b ', ''] })
  assert.equal(g.name, 'Прогрев RU')
  assert.deepEqual(g.accountIds, ['a', 'b'])
  assert.equal(g.color, '')
  assert.equal(g.note, '')
})

test('§12 accountsOfGroups: объединяет аккаунты выбранных групп без дублей', () => {
  const groups = [
    { id: 'g1', name: 'RU', accountIds: ['a1', 'a2'] },
    { id: 'g2', name: 'UA', accountIds: ['a2', 'a3'] },
    { id: 'g3', name: 'Не выбрана', accountIds: ['zz'] },
  ]
  assert.deepEqual(accountsOfGroups(groups, ['g1', 'g2']).sort(), ['a1', 'a2', 'a3'])
  assert.deepEqual(accountsOfGroups(groups, []), [])
  assert.deepEqual(accountsOfGroups([], ['g1']), [])
})

test('§12 groupsByAccount: карта аккаунт → его группы', () => {
  const map = groupsByAccount([
    { id: 'g1', name: 'RU', accountIds: ['a1', 'a2'] },
    { id: 'g2', name: 'UA', accountIds: ['a2'] },
  ])
  assert.deepEqual(map.a1.map((g) => g.name), ['RU'])
  assert.deepEqual(map.a2.map((g) => g.name), ['RU', 'UA']) // состоит в двух
  assert.equal(map.нет, undefined)
})

test('§12 isAccountAllowedViaGroups: доступ через группу, точечный запрет сильнее', () => {
  const groups = [{ id: 'g1', name: 'RU', accountIds: ['a1', 'a2'] }]
  // доступ выдан на группу — аккаунт группы разрешён
  assert.equal(isAccountAllowedViaGroups({}, { g1: 'allow' }, groups, 'a1'), true)
  // аккаунт вне группы — нет
  assert.equal(isAccountAllowedViaGroups({}, { g1: 'allow' }, groups, 'чужой'), false)
  // группа не разрешена — нет
  assert.equal(isAccountAllowedViaGroups({}, {}, groups, 'a1'), false)
  // явный deny на группу — нет
  assert.equal(isAccountAllowedViaGroups({}, { g1: 'deny' }, groups, 'a1'), false)
  // точечный запрет перебивает разрешённую группу
  assert.equal(isAccountAllowedViaGroups({ a1: 'deny' }, { g1: 'allow' }, groups, 'a1'), false)
  // точечное разрешение работает и без групп
  assert.equal(isAccountAllowedViaGroups({ solo: 'allow' }, {}, groups, 'solo'), true)
})

test('§12 контракт значений — строки, а не boolean (регрессия: сравнение с true/false молча ломало доступ)', () => {
  const groups = [{ id: 'g1', name: 'RU', accountIds: ['a1'] }]
  // булевы значения — не наш контракт: доступ не выдаётся (лучше отказать, чем пустить лишнего)
  assert.equal(isAccountAllowedViaGroups({}, { g1: true }, groups, 'a1'), false)
  assert.equal(isAccountAllowedViaGroups({ a1: true }, {}, groups, 'a1'), false)
})

test('§12 CRUD групп на изолированном файле', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-groups-'))
  process.env.ACCOUNT_GROUPS_FILE = path.join(dir, 'groups.json')
  const G = await import('../accountGroups.js?crud=' + Date.now())

  assert.deepEqual(await G.listGroups(), [])
  const created = await G.createGroup({ name: 'Прогрев', accountIds: ['a1'] })
  assert.ok(created.id.startsWith('grp_'))

  const upd = await G.updateGroup(created.id, { accountIds: ['a1', 'a2'], color: 'spark' })
  assert.deepEqual(upd.accountIds, ['a1', 'a2'])
  assert.equal(upd.color, 'spark')

  assert.equal(await G.updateGroup('нет', {}), null)
  assert.equal(await G.deleteGroup(created.id), true)
  assert.equal(await G.deleteGroup('нет'), false)
  assert.deepEqual(await G.listGroups(), [])

  await assert.rejects(() => G.createGroup({ accountIds: ['x'] }), /название/i)
  delete process.env.ACCOUNT_GROUPS_FILE
})
