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

test('updateCampaign: массивы и per-module карты не строкифицируются', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaigns-pm-'))
  process.env.CAMPAIGNS_FILE = path.join(dir, 'campaigns.json')
  const C = await import('../campaigns.js?pm=' + Date.now())

  const created = await C.createCampaign({ name: 'Мульти', moduleKey: 'neuro-commenting' })
  // Редактирование шлёт весь набор (как форма): modules — массив, moduleAgents/moduleSettings —
  // объекты, targets — массив. Раньше цикл по FIELDS прогонял их через String() и портил.
  const upd = await C.updateCampaign(created.id, {
    moduleKey: 'neuro-commenting',
    modules: ['neuro-commenting', 'mailing'],
    moduleAgents: { 'neuro-commenting': 'ag1', mailing: 'ag2' },
    moduleSettings: { 'neuro-commenting': { maxComments: 20 }, mailing: {} },
    moduleTargets: { mailing: ['+79991234567', '@user1'] },
    targets: ['@Crypto', 'crypto'],
  })
  assert.deepEqual(upd.modules, ['neuro-commenting', 'mailing'])
  assert.deepEqual(upd.moduleAgents, { 'neuro-commenting': 'ag1', mailing: 'ag2' })
  // Пустой пресет модуля отбрасывается, непустой сохраняется как объект.
  assert.deepEqual(upd.moduleSettings, { 'neuro-commenting': { maxComments: 20 } })
  // Номер получателя рассылки НЕ приводится к нижнему регистру и не теряет '+'.
  assert.deepEqual(upd.moduleTargets, { mailing: ['+79991234567', '@user1'] })
  // Общие каналы нормализуются (без @, нижний регистр, без дублей) — @Crypto и crypto = один.
  assert.deepEqual(upd.targets, ['crypto'])

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

// ── Дедлайн и дожим переехали в кампанию (решение 24.07) ──
test('дедлайн кампании: отсекаем опечатки в годе и несуществующие даты', async () => {
  const { normalizeCampaign } = await import('../campaigns.js')
  // Найдено ручным тестом 21.07 (тогда поле было у цели): проходил год 123123 —
  // на карточке рисовалось «до 24.07.123123», и срок не наступал никогда.
  assert.equal(normalizeCampaign({ name: 'x', deadline: '123123-07-24' }).deadline, null)
  assert.equal(normalizeCampaign({ name: 'x', deadline: '1899-01-01' }).deadline, null)
  assert.equal(normalizeCampaign({ name: 'x', deadline: 'abc' }).deadline, null)
  // Date «доворачивает» 31 февраля на март — такую дату не принимаем.
  assert.equal(normalizeCampaign({ name: 'x', deadline: '2026-02-31' }).deadline, null)
  // Нормальные проходят; прошлое разрешено — по нему проверяют «просрочено».
  assert.equal(normalizeCampaign({ name: 'x', deadline: '2026-12-31' }).deadline, '2026-12-31')
  assert.equal(normalizeCampaign({ name: 'x' }).deadline, null)
})

test('дожим у кампании, а не у агента: лимит клампится, мусор не ломает', async () => {
  const { normalizeCampaign, FOLLOW_UP_MAX, FOLLOW_UP_DEFAULT } = await import('../campaigns.js')
  assert.deepEqual(normalizeCampaign({ name: 'x' }).followUp,
    { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' })
  const c = normalizeCampaign({ name: 'x', followUp: { enabled: true, limit: 999 } })
  assert.equal(c.followUp.limit, FOLLOW_UP_MAX, 'потолок держим')
  assert.equal(c.followUp.enabled, true)
  assert.equal(normalizeCampaign({ name: 'x', followUp: 'мусор' }).followUp.enabled, false)
})

test('агент не решает, дожимать ли — это дело кампании', async () => {
  const { normalizeAgent } = await import('../agents.js')
  const a = normalizeAgent({ name: 'A', followUp: { enabled: true, limit: 5 } })
  assert.equal(a.followUp, undefined, 'агент — про манеру речи, а не про ход работы')
})

test('агент принял аудиторию и критерий завершения из цели', async () => {
  const { normalizeAgent } = await import('../agents.js')
  const a = normalizeAgent({ name: 'A', audience: 'трейдеры', completionCriteria: 'перешёл по ссылке' })
  assert.equal(a.audience, 'трейдеры')
  assert.equal(a.completionCriteria, 'перешёл по ссылке')
})
