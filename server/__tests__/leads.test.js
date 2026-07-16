import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeLead, LEAD_STATUSES, hasActiveHotLead, DIALOG_MODULES, activeLeadCount, leadPriority, sortLeadsByPriority } from '../leads.js'

test('activeLeadCount: считает лиды в работе (cold/answered/hot), не target/closed', () => {
  const leads = [
    { accountId: 'a', status: 'cold' }, { accountId: 'a', status: 'answered' },
    { accountId: 'a', status: 'hot' }, { accountId: 'a', status: 'target' },
    { accountId: 'a', status: 'closed' }, { accountId: 'b', status: 'hot' },
  ]
  assert.equal(activeLeadCount(leads, 'a'), 3) // cold+answered+hot
  assert.equal(activeLeadCount(leads, 'b'), 1)
  assert.equal(activeLeadCount(leads, 'нет'), 0)
})

test('leadPriority + sortLeadsByPriority: ответивший/горячий — выше', () => {
  assert.ok(leadPriority('hot') > leadPriority('answered'))
  assert.ok(leadPriority('answered') > leadPriority('cold'))
  const sorted = sortLeadsByPriority([
    { id: '1', status: 'cold' }, { id: '2', status: 'hot' }, { id: '3', status: 'answered' },
  ])
  assert.deepEqual(sorted.map((l) => l.id), ['2', '3', '1'])
})

test('assertActiveDialogLimit: блок при превышении, только для диалоговых модулей', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-dlg-'))
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const m = await import('../leads.js?dlg=' + Date.now())
  await m.createLead({ peer: '@x', accountId: 'acc1', status: 'hot' })
  await m.createLead({ peer: '@y', accountId: 'acc1', status: 'answered' })

  // лимит 2, у acc1 — 2 активных → блок в диалоговом модуле
  assert.match(await m.assertActiveDialogLimit(['acc1'], 'neuro-chatting', 2), /лимит активных диалогов/i)
  // лимит 5 → ок
  assert.equal(await m.assertActiveDialogLimit(['acc1'], 'neuro-chatting', 5), null)
  // не-диалоговый модуль → не проверяем
  assert.equal(await m.assertActiveDialogLimit(['acc1'], 'mass-react', 1), null)
  // лимит 0 → без ограничения
  assert.equal(await m.assertActiveDialogLimit(['acc1'], 'neuro-chatting', 0), null)
  delete process.env.LEADS_FILE
})

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

test('leadPriorityMap / dialogLeadPriority / sortDialogsByLeadPriority (§3.6 приоритет)', async () => {
  const { leadPriorityMap, dialogLeadPriority, sortDialogsByLeadPriority } = await import('../leads.js')
  const leads = [
    { peer: '@hotguy', status: 'hot' },      // 4
    { peer: 'answered_user', status: 'answered' }, // 3
    { peer: '12345', status: 'cold' },       // 1
  ]
  const map = leadPriorityMap(leads)
  assert.equal(map.hotguy, 4)
  assert.equal(map.answered_user, 3)
  // dialog по username (регистр/@ нормализуются)
  assert.equal(dialogLeadPriority({ entity: { username: 'HotGuy' } }, map), 4)
  assert.equal(dialogLeadPriority({ entity: { id: 12345 } }, map), 1)
  assert.equal(dialogLeadPriority({ entity: { username: 'nobody' } }, map), 1) // нет лида → cold
  // сортировка: hot → answered → без лида (стабильно)
  const dialogs = [
    { name: 'X', entity: { username: 'nobody' } },
    { name: 'A', entity: { username: 'answered_user' } },
    { name: 'H', entity: { username: 'hotguy' } },
  ]
  const sorted = sortDialogsByLeadPriority(dialogs, leads)
  assert.deepEqual(sorted.map((d) => d.name), ['H', 'A', 'X'])
})
