import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeCampaign, CAMPAIGN_STATUSES, pinnedAccountMap, isAccountFree, conflictingAccounts } from '../campaigns.js'

test('normalizeCampaign: дефолты и типы', () => {
  const c = normalizeCampaign({ name: '  Прогрев IT  ', moduleKey: ' warming ', accountIds: ['a', 'a', ' b ', ''] })
  assert.equal(c.name, 'Прогрев IT') // trim
  assert.equal(c.moduleKey, 'warming')
  assert.deepEqual(c.accountIds, ['a', 'b']) // дедуп + trim + без пустых
  assert.equal(c.goalId, null)
  assert.equal(c.pinned, true) // по умолчанию закрепляем
  assert.equal(c.status, 'draft') // неизвестный/пустой → draft
  assert.deepEqual(c.settings, {})
  assert.equal(normalizeCampaign({ status: 'active' }).status, 'active')
  assert.equal(normalizeCampaign({ status: 'мусор' }).status, 'draft')
  assert.equal(normalizeCampaign({ pinned: false }).pinned, false)
})

test('CAMPAIGN_STATUSES — жизненный цикл', () => {
  assert.deepEqual(CAMPAIGN_STATUSES, ['draft', 'active', 'paused', 'done'])
})

test('§1/§5 pinnedAccountMap: закреплённые аккаунты, done — отпускает', () => {
  const map = pinnedAccountMap([
    { id: 'c1', name: 'Крипта', pinned: true, status: 'active', accountIds: ['a1', 'a2'] },
    { id: 'c2', name: 'Старая', pinned: true, status: 'done', accountIds: ['a3'] }, // завершена → не держит
    { id: 'c3', name: 'Без лока', pinned: false, status: 'active', accountIds: ['a4'] }, // без лока
  ])
  assert.deepEqual(map.a1, { campaignId: 'c1', name: 'Крипта' })
  assert.equal(map.a2.campaignId, 'c1')
  assert.equal(map.a3, undefined) // done отпустила
  assert.equal(map.a4, undefined) // pinned:false не держит
})

test('§5 isAccountFree / conflictingAccounts: своя кампания не мешает', () => {
  const map = pinnedAccountMap([{ id: 'c1', name: 'X', pinned: true, status: 'active', accountIds: ['a1'] }])
  assert.equal(isAccountFree(map, 'free'), true) // никем не закреплён
  assert.equal(isAccountFree(map, 'a1'), false) // закреплён чужой
  assert.equal(isAccountFree(map, 'a1', 'c1'), true) // своя же кампания — ок
  assert.deepEqual(conflictingAccounts(map, ['a1', 'free'], 'c2'), ['a1'])
  assert.deepEqual(conflictingAccounts(map, ['a1', 'free'], 'c1'), []) // редактируем свою — конфликтов нет
})

test('CRUD кампаний на изолированном файле', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaigns-'))
  process.env.CAMPAIGNS_FILE = path.join(dir, 'campaigns.json')
  const C = await import('../campaigns.js?crud=' + Date.now())

  assert.deepEqual(await C.listCampaigns(), [])

  const created = await C.createCampaign({ name: 'Крипта', moduleKey: 'neuro-commenting', goalId: 'g1', accountIds: ['a1'] })
  assert.ok(created.id.startsWith('cmp_'))
  assert.equal(created.moduleKey, 'neuro-commenting')
  assert.equal(created.status, 'draft')

  // фильтры
  assert.equal((await C.listCampaigns({ goalId: 'g1' })).length, 1)
  assert.equal((await C.listCampaigns({ goalId: 'нет' })).length, 0)
  assert.equal((await C.listCampaigns({ moduleKey: 'neuro-commenting' })).length, 1)

  const upd = await C.updateCampaign(created.id, { status: 'active', accountIds: ['a1', 'a2'], settings: { maxActions: 10 } })
  assert.equal(upd.status, 'active')
  assert.deepEqual(upd.accountIds, ['a1', 'a2'])
  assert.equal(upd.settings.maxActions, 10)
  assert.ok(upd.updatedAt >= created.updatedAt)

  // невалидный статус не затирает
  assert.equal((await C.updateCampaign(created.id, { status: 'мусор' })).status, 'active')

  assert.equal(await C.updateCampaign('нет', {}), null)
  assert.equal(await C.deleteCampaign('нет'), false)
  assert.equal(await C.deleteCampaign(created.id), true)
  assert.deepEqual(await C.listCampaigns(), [])

  delete process.env.CAMPAIGNS_FILE
})

test('createCampaign: без имени и без модуля — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaigns-err-'))
  process.env.CAMPAIGNS_FILE = path.join(dir, 'campaigns.json')
  const C = await import('../campaigns.js?err=' + Date.now())
  await assert.rejects(() => C.createCampaign({ moduleKey: 'warming' }), /название/i)
  // §0: кампания обязана настраивать модуль — «неконтролируемая кампания» не нужна
  await assert.rejects(() => C.createCampaign({ name: 'Без модуля' }), /модул/i)
  delete process.env.CAMPAIGNS_FILE
})
