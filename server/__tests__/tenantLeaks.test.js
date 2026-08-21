/**
 * Аудит 21.08 (продолжение истории с каталогом ролей): чужие данные между клиентами.
 *
 * Списки (`GET /`) после аудита 20.08 закрыли `ownedForRequest`/`channelsForRequest`,
 * а ТОЧЕЧНЫЕ роуты по id остались без владельца: `/:id` на чтение, `PUT`/`DELETE`
 * на запись. Id не секрет — он виден в интерфейсе, в ссылках, в логах задач и в
 * ответах соседних роутов, поэтому «скрыли в списке» это не защита, а косметика.
 *
 * Каждый тест поднимает НАСТОЯЩИЙ роутер в express и ходит по HTTP от лица ЧУЖОГО
 * клиента. Падение теста = воспроизведённая утечка, а не мнение о коде.
 *
 * Ожидание одно на все тесты: чужая запись должна отвечать 403/404 и НЕ отдавать
 * содержимое; чужая правка/удаление — не проходить.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── Изоляция хранилищ. Часть модулей читает env В МОМЕНТ ИМПОРТА (leads, campaigns,
// proxies, account-groups), поэтому переменные выставляем ДО первого import.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tenant-leaks-'))
process.env.USERS_FILE = path.join(tmp, 'users.json')
process.env.ROLES_FILE = path.join(tmp, 'roles.json')
process.env.GOALS_FILE = path.join(tmp, 'goals.json')
process.env.LEADS_FILE = path.join(tmp, 'leads.json')
process.env.CAMPAIGNS_FILE = path.join(tmp, 'campaigns.json')
process.env.CAMPAIGN_SCHEDULES_FILE = path.join(tmp, 'campaign-schedules.json')
process.env.AGENTS_FILE = path.join(tmp, 'agents.json')
process.env.KB_FILE = path.join(tmp, 'knowledge.json')
process.env.PROXIES_FILE = path.join(tmp, 'proxies.json')
process.env.ACCOUNT_GROUPS_FILE = path.join(tmp, 'account-groups.json')
process.env.BALANCE_FILE = path.join(tmp, 'balance.json')

const express = (await import('express')).default
const { createUser } = await import('../users.js')
const { createRole } = await import('../roles.js')
const { createGoal } = await import('../goals.js')
const { createKb } = await import('../knowledgeBase.js')
const { createLead } = await import('../leads.js')
const { createCampaign } = await import('../campaigns.js')
const { createSchedule } = await import('../campaignSchedules.js')
const { createAgent } = await import('../agents.js')
const { createProxy } = await import('../proxies.js')
const { createGroup } = await import('../accountGroups.js')

const { goalsRouter } = await import('../goalsRoutes.js')
const { campaignsRouter } = await import('../campaignsRoutes.js')
const { agentsRouter } = await import('../agentsRoutes.js')
const { leadsRouter } = await import('../leadsRoutes.js')
const { proxiesRouter } = await import('../proxiesRoutes.js')
const { rolesRouter } = await import('../rolesRoutes.js')
const { accountGroupsRouter } = await import('../accountGroupsRoutes.js')

// ── Два независимых клиента платформы. Роль обычная (не админская), иначе
// requesterContext выдал бы sudo и утечки «легально» не было бы.
const plainRole = await createRole({ name: 'Клиент (тест утечек)', permissions: {} })
const alice = await createUser({ email: `alice-${Date.now()}@t.io`, name: 'Алиса', password: 'x12345', roleIds: [plainRole.id] })
const bob = await createUser({ email: `bob-${Date.now()}@t.io`, name: 'Боб', password: 'x12345', roleIds: [plainRole.id] })

// ── Данные Алисы. Боб не должен увидеть ни одного из этих значений.
const goalA = await createGoal({ name: 'Цель Алисы: 500 лидов по крипте', description: 'секретная стратегия', userId: alice.id })
const kbA = await createKb(goalA.id, { kind: 'text', title: 'Прайс Алисы', content: 'опт от 100 шт — 40% скидка' })
const leadA = await createLead({ peer: '@victim_of_alice', accountId: 'acc_alice_1', status: 'hot', note: 'готов купить, телефон в личке' })
const campA = await createCampaign({ name: 'Кампания Алисы', goalId: goalA.id, modules: ['mailing'], userId: alice.id })
const schedA = await createSchedule({ name: 'Расписание Алисы', body: { modules: ['mailing'] }, userId: alice.id })
const agentA = await createAgent({ name: 'Персона Алисы', toneOfVoice: 'дерзко', firstMessage: 'Привет! Есть тема.' })
const proxyA = await createProxy({ ownerId: alice.id, host: '10.0.0.1', port: 1080, scheme: 'socks5', username: 'alice_login', password: 'alice_secret' })
const groupA = await createGroup({ name: 'Группа Алисы', accountIds: ['acc_alice_1'], userId: alice.id })
const roleA = await createRole({ name: 'Роль Алисы', userId: alice.id, permissions: { resources: { accounts: { acc_alice_1: 'allow' } } } })

// ── Мини-сервер с настоящими роутерами.
const app = express()
app.use(express.json())
app.use('/api/goals', goalsRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/agents', agentsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/proxies', proxiesRouter)
app.use('/api/roles', rolesRouter)
app.use('/api/account-groups', accountGroupsRouter)
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

/** Запрос от лица пользователя: x-user-id ставит sessionGuard из подписанной сессии. */
async function as(userId, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'x-user-id': userId, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try { json = await res.json() } catch { /* не JSON — оставим null */ }
  return { status: res.status, body: json }
}

/** Чужая запись = «нет доступа» либо «не найдено». 200 с содержимым — утечка. */
const denied = (r) => r.status === 403 || r.status === 404

test.after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(tmp, { recursive: true, force: true })
})

// ─────────────────────────── ЦЕЛИ ───────────────────────────

test('GET /api/goals/:id — чужая цель не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/goals/${goalA.id}`)
  assert.ok(denied(r), `Боб прочитал цель Алисы: ${JSON.stringify(r.body?.goal)}`)
})

test('GET /api/goals/progress — счётчики чужих целей не отдаются', async () => {
  const r = await as(bob.id, 'GET', '/api/goals/progress')
  const ids = Object.keys(r.body?.progress || {})
  assert.ok(!ids.includes(goalA.id), 'в сводке прогресса видна чужая цель — это факт её существования и её счётчики')
})

test('GET /api/goals/:goalId/kb — база знаний чужой цели не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/goals/${goalA.id}/kb`)
  const titles = (r.body?.items || []).map((i) => i.title)
  assert.ok(!titles.includes(kbA.title), `Боб прочитал КБ Алисы: ${JSON.stringify(r.body?.items)}`)
})

test('PUT /api/goals/:id — чужую цель нельзя переписать (IDOR)', async () => {
  const r = await as(bob.id, 'PUT', `/api/goals/${goalA.id}`, { name: 'Взломано Бобом' })
  assert.ok(denied(r), 'Боб переименовал цель Алисы')
})

test('DELETE /api/goals/:id — чужую цель нельзя удалить (IDOR)', async () => {
  const victim = await createGoal({ name: 'Цель на снос', userId: alice.id })
  const r = await as(bob.id, 'DELETE', `/api/goals/${victim.id}`)
  assert.ok(denied(r), 'Боб удалил цель Алисы вместе с её базой знаний')
})

// ─────────────────────────── КАМПАНИИ ───────────────────────────

test('GET /api/campaigns/:id — чужая кампания не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/campaigns/${campA.id}`)
  assert.ok(denied(r), `Боб прочитал кампанию Алисы: ${JSON.stringify(r.body?.campaign)}`)
})

test('PUT /api/campaigns/:id — чужую кампанию нельзя править (IDOR)', async () => {
  const r = await as(bob.id, 'PUT', `/api/campaigns/${campA.id}`, { name: 'Кампания Боба' })
  assert.ok(denied(r), 'Боб переписал чужую кампанию')
})

test('DELETE /api/campaigns/schedules/:id — чужое расписание нельзя удалить (IDOR)', async () => {
  const r = await as(bob.id, 'DELETE', `/api/campaigns/schedules/${schedA.id}`)
  assert.ok(denied(r), 'Боб снёс запланированную кампанию Алисы')
})

// ─────────────────────────── ЛИДЫ (CRM) ───────────────────────────

test('GET /api/leads — чужие лиды не отдаются', async () => {
  const r = await as(bob.id, 'GET', '/api/leads')
  const peers = (r.body?.leads || []).map((l) => l.peer)
  assert.ok(!peers.includes(leadA.peer), `Боб получил CRM Алисы целиком: ${JSON.stringify(r.body?.leads)}`)
})

test('PUT /api/leads/:id — чужого лида нельзя перевесить на свой аккаунт (IDOR)', async () => {
  const r = await as(bob.id, 'PUT', `/api/leads/${leadA.id}`, { accountId: 'acc_bob_1', status: 'closed' })
  assert.ok(denied(r), 'Боб забрал горячий лид Алисы себе')
})

test('DELETE /api/leads/:id — чужого лида нельзя удалить (IDOR)', async () => {
  const victim = await createLead({ peer: '@another_victim', accountId: 'acc_alice_1' })
  const r = await as(bob.id, 'DELETE', `/api/leads/${victim.id}`)
  assert.ok(denied(r), 'Боб удалил лид из чужой CRM')
})

// ─────────────────────────── АГЕНТЫ И ИХ БАЗА ЗНАНИЙ ───────────────────────────

test('GET /api/agents/:id — чужой агент (промпты, первое сообщение) не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/agents/${agentA.id}`)
  assert.ok(denied(r), `Боб прочитал персону Алисы: ${JSON.stringify(r.body?.agent)}`)
})

test('PUT /api/agents/:id — чужого агента нельзя переписать (IDOR)', async () => {
  const r = await as(bob.id, 'PUT', `/api/agents/${agentA.id}`, { toneOfVoice: 'подменено' })
  assert.ok(denied(r), 'Боб переписал промпт чужого агента — это меняет речь его рассылок')
})

// ─────────────────────────── ПРОКСИ (ЛОГИН/ПАРОЛЬ) ───────────────────────────

test('GET /api/proxies/:id — чужой прокси с логином и паролем не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/proxies/${proxyA.id}`)
  assert.ok(denied(r), `Боб получил креды прокси Алисы: ${JSON.stringify(r.body?.proxy)}`)
  assert.notEqual(r.body?.proxy?.password, 'alice_secret', 'пароль прокси ушёл чужому клиенту')
})

// ─────────────────────────── ГРУППЫ АККАУНТОВ ───────────────────────────

test('GET /api/account-groups/:id — чужая группа (состав аккаунтов) не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/account-groups/${groupA.id}`)
  assert.ok(denied(r), `Боб увидел состав чужой группы: ${JSON.stringify(r.body?.group)}`)
})

// ─────────────────────────── РОЛИ ───────────────────────────

test('GET /api/roles/:id — чужая роль (и её выдачи на аккаунты) не отдаётся', async () => {
  const r = await as(bob.id, 'GET', `/api/roles/${roleA.id}`)
  assert.ok(denied(r), `Боб прочитал чужую роль: ${JSON.stringify(r.body?.role)}`)
})
