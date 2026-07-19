import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeLead, LEAD_STATUSES, hasActiveHotLead, DIALOG_MODULES, activeLeadCount, leadPriority, sortLeadsByPriority, advanceLeadStatus } from '../leads.js'

test('activeLeadCount: считает лиды в работе (вся воронка кроме target/closed)', () => {
  const leads = [
    { accountId: 'a', status: 'cold' }, { accountId: 'a', status: 'contacted' },
    { accountId: 'a', status: 'warm' }, { accountId: 'a', status: 'interested' },
    { accountId: 'a', status: 'hot' }, { accountId: 'a', status: 'target' },
    { accountId: 'a', status: 'closed' }, { accountId: 'b', status: 'hot' },
  ]
  assert.equal(activeLeadCount(leads, 'a'), 5) // cold+contacted+warm+interested+hot
  assert.equal(activeLeadCount(leads, 'b'), 1)
  assert.equal(activeLeadCount(leads, 'нет'), 0)
})

test('leadPriority + sortLeadsByPriority: горячее по воронке — выше', () => {
  assert.ok(leadPriority('hot') > leadPriority('interested'))
  assert.ok(leadPriority('interested') > leadPriority('warm'))
  assert.ok(leadPriority('warm') > leadPriority('contacted'))
  assert.ok(leadPriority('contacted') > leadPriority('cold'))
  const sorted = sortLeadsByPriority([
    { id: '1', status: 'cold' }, { id: '2', status: 'hot' }, { id: '3', status: 'interested' },
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

test('normalizeLead: дефолт статуса, легаси-алиас и типы', () => {
  const l = normalizeLead({ peer: ' @user ', status: 'непонятно', goalId: 'g1' })
  assert.equal(l.status, 'cold') // невалидный статус → cold
  assert.equal(l.peer, '@user') // trim
  assert.equal(l.goalId, 'g1')
  assert.equal(l.accountId, null)
  // легаси-статус старой воронки нормализуется в новую
  assert.equal(normalizeLead({ peer: '@x', status: 'answered' }).status, 'warm')
})

test('LEAD_STATUSES — воронка прогрева (§9)', () => {
  assert.deepEqual(LEAD_STATUSES, ['cold', 'contacted', 'warm', 'interested', 'hot', 'target', 'closed'])
})

test('§9 advanceLeadStatus: только вперёд, терминальные не откатываются', () => {
  assert.equal(advanceLeadStatus(null, 'contacted'), 'contacted') // новый
  assert.equal(advanceLeadStatus('cold', 'contacted'), 'contacted') // продвижение
  assert.equal(advanceLeadStatus('hot', 'contacted'), 'hot') // не понижаем прогретого
  assert.equal(advanceLeadStatus('warm', 'interested'), 'interested') // выше по воронке
  assert.equal(advanceLeadStatus('interested', 'warm'), 'interested') // назад нельзя
  assert.equal(advanceLeadStatus('target', 'contacted'), 'target') // терминальный не трогаем
  assert.equal(advanceLeadStatus('closed', 'hot'), 'closed') // закрытый не оживляем
})

test('§9 upsertLead: создаёт новый и продвигает существующий (изолированный файл)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-upsert-'))
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const L = await import('../leads.js?upsert=' + Date.now())

  const a = await L.upsertLead({ peer: '@Client', goalId: 'g1', accountId: 'acc1', status: 'contacted' })
  assert.equal(a.created, true)
  assert.equal(a.lead.status, 'contacted')

  // тот же peer+goal (регистр/@ нормализуются) — обновление, продвижение вперёд
  const b = await L.upsertLead({ peer: 'client', goalId: 'g1', status: 'warm' })
  assert.equal(b.created, false)
  assert.equal(b.lead.id, a.lead.id) // тот же лид
  assert.equal(b.lead.status, 'warm')

  // попытка «понизить» — статус не откатывается
  const c = await L.upsertLead({ peer: '@client', goalId: 'g1', status: 'cold' })
  assert.equal(c.lead.status, 'warm')

  // другая цель — отдельный лид
  const d = await L.upsertLead({ peer: '@client', goalId: 'g2', status: 'contacted' })
  assert.equal(d.created, true)
  assert.equal((await L.listLeads()).length, 2)

  delete process.env.LEADS_FILE
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
    { peer: '@hotguy', status: 'hot' },          // 6
    { peer: 'warm_user', status: 'interested' }, // 5
    { peer: '12345', status: 'cold' },           // 1
  ]
  const map = leadPriorityMap(leads)
  assert.equal(map.hotguy, 6)
  assert.equal(map.warm_user, 5)
  // dialog по username (регистр/@ нормализуются)
  assert.equal(dialogLeadPriority({ entity: { username: 'HotGuy' } }, map), 6)
  assert.equal(dialogLeadPriority({ entity: { id: 12345 } }, map), 1)
  assert.equal(dialogLeadPriority({ entity: { username: 'nobody' } }, map), 1) // нет лида → cold
  // сортировка: hot → answered → без лида (стабильно)
  const dialogs = [
    { name: 'X', entity: { username: 'nobody' } },
    { name: 'A', entity: { username: 'warm_user' } },
    { name: 'H', entity: { username: 'hotguy' } },
  ]
  const sorted = sortDialogsByLeadPriority(dialogs, leads)
  assert.deepEqual(sorted.map((d) => d.name), ['H', 'A', 'X'])
})
