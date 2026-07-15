import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeLead, LEAD_STATUSES, hasActiveHotLead, DIALOG_MODULES } from '../leads.js'

test('hasActiveHotLead: находит горячий лид аккаунта', () => {
  const leads = [
    { accountId: 'a1', status: 'cold' },
    { accountId: 'a2', status: 'hot' },
    { accountId: 'a3', status: 'answered' },
  ]
  assert.equal(hasActiveHotLead(leads, 'a2'), true)
  assert.equal(hasActiveHotLead(leads, 'a1'), false)
  assert.equal(hasActiveHotLead(leads, 'нет'), false)
  assert.equal(hasActiveHotLead(null, 'a2'), false)
})

test('assertNoHotLeadConflict: блокирует не-диалоговый модуль, пропускает диалоговый', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-hot-'))
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const m = await import('../leads.js?hot=' + Date.now())
  await m.createLead({ peer: '@x', accountId: 'acc123456', status: 'hot' })

  // не-диалоговый модуль — блок
  const err = await m.assertNoHotLeadConflict(['acc123456'], 'mass-react')
  assert.match(err, /горячий лид/i)
  // диалоговый модуль (ведёт диалог) — пропуск
  assert.equal(await m.assertNoHotLeadConflict(['acc123456'], 'neuro-chatting'), null)
  assert.ok(DIALOG_MODULES.has('neuro-dialogs'))
  // аккаунт без горячего лида — пропуск
  assert.equal(await m.assertNoHotLeadConflict(['free'], 'mass-react'), null)

  delete process.env.LEADS_FILE
})

test('normalizeLead: дефолт статуса и типы', () => {
  const l = normalizeLead({ peer: ' @user ', status: 'непонятно', goalId: 'g1' })
  assert.equal(l.status, 'cold') // невалидный статус → cold
  assert.equal(l.peer, '@user') // trim
  assert.equal(l.goalId, 'g1')
  assert.equal(l.accountId, null)
})

test('LEAD_STATUSES — воронка', () => {
  assert.deepEqual(LEAD_STATUSES, ['cold', 'answered', 'hot', 'target', 'closed'])
})

test('CRUD + фильтры + stats (изолированный файл)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-'))
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const L = await import('../leads.js?crud=' + Date.now())

  const a = await L.createLead({ peer: '@a', goalId: 'g1', accountId: 'acc1', status: 'answered' })
  await L.createLead({ peer: '@b', goalId: 'g1', status: 'hot' })
  await L.createLead({ peer: '@c', goalId: 'g2', status: 'cold' })

  assert.equal((await L.listLeads({ goalId: 'g1' })).length, 2)
  assert.equal((await L.listLeads({ status: 'hot' })).length, 1)
  assert.equal((await L.listLeads({ accountId: 'acc1' })).length, 1)

  const upd = await L.updateLead(a.id, { status: 'hot' })
  assert.equal(upd.status, 'hot')
  assert.equal(upd.isHot, true) // isHot следует за статусом

  const stats = await L.leadStats('g1')
  assert.equal(stats.total, 2)
  assert.equal(stats.byStatus.hot, 2)

  assert.equal(await L.deleteLead(a.id), true)
  assert.equal(await L.deleteLead('нет'), false)

  delete process.env.LEADS_FILE
})

test('createLead без peer — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-'))
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const L = await import('../leads.js?err=' + Date.now())
  await assert.rejects(() => L.createLead({ goalId: 'g1' }), /контакт/i)
  delete process.env.LEADS_FILE
})
