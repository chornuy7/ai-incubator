/**
 * Аудит 21.08, часть вторая: то, что нельзя проверить обычным CRUD-запросом.
 *
 * 1) Папки целей и внешний API v1 — проверяем настоящими вызовами.
 * 2) Роуты «по аккаунту» (`/api/tg/accounts/:accountId/...`, нейро-диалоги) живут в
 *    server/index.js, который при импорте поднимает сервер, планировщик и воркеров, —
 *    в юнит-тесте его не запустить. Поэтому здесь проверяем НАЛИЧИЕ ГЕЙТА в исходнике:
 *    у каждого такого роута обязан быть `canSeeAccount` (он уже используется в
 *    /api/accounts/:accountId/work — то есть правило в проекте есть, оно просто не
 *    применено к остальным). Тест падает ровно там, где гейта нет.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srv = (f) => path.join(here, '..', f)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tenant-accounts-'))
process.env.USERS_FILE = path.join(tmp, 'users.json')
process.env.ROLES_FILE = path.join(tmp, 'roles.json')
process.env.GOALS_FILE = path.join(tmp, 'goals.json')
process.env.CAMPAIGNS_FILE = path.join(tmp, 'campaigns.json')
process.env.API_KEYS_FILE = path.join(tmp, 'api-keys.json')

const express = (await import('express')).default
const { createUser } = await import('../users.js')
const { createRole } = await import('../roles.js')
const { createGoal } = await import('../goals.js')
const { createCampaign } = await import('../campaigns.js')

const plainRole = await createRole({ name: 'Клиент (тест аккаунтов)', permissions: {} })
const alice = await createUser({ email: `a-acc-${Date.now()}@t.io`, name: 'Алиса', password: 'x12345', roleIds: [plainRole.id] })
const bob = await createUser({ email: `b-acc-${Date.now()}@t.io`, name: 'Боб', password: 'x12345', roleIds: [plainRole.id] })

const goalA = await createGoal({ name: 'Цель Алисы (api v1)', userId: alice.id })
const campA = await createCampaign({ name: 'Кампания Алисы (api v1)', modules: ['mailing'], userId: alice.id })

test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

// ─────────────────────────── ПАПКИ ЦЕЛЕЙ ───────────────────────────

/**
 * Папки (`server/targetFolders.js`) вообще не хранят владельца, а `foldersForRequest`
 * режет их ТОЛЬКО ролью: если в роли не задан раздел `resources.folders`, она не
 * ограничивает ничего (roles.js:484 «права папок не заданы — не ограничиваем»).
 * Обычная роль клиента такого раздела не содержит — значит он видит базы каналов
 * всех клиентов платформы.
 */
test('GET /api/target-folders: клиент не должен видеть папки чужого клиента', async () => {
  const { foldersForRequest } = await import('../lib/accessGuard.js')
  const req = { header: (h) => (String(h).toLowerCase() === 'x-user-id' ? bob.id : undefined) }
  const folders = [
    { id: 'fld_alice', name: 'База Алисы', targets: ['secret_channel_a', 'secret_chat_a'] },
    { id: 'fld_bob', name: 'База Боба', targets: ['bob_channel'] },
  ]
  const seen = await foldersForRequest(req, folders)
  const ids = seen.map((f) => f.id)
  assert.ok(!ids.includes('fld_alice'), `Боб видит чужую папку с её целями: ${JSON.stringify(seen)}`)
})

// ─────────────────────────── ВНЕШНИЙ API v1 ───────────────────────────

/**
 * §10.3: ключ «действует ОТ ИМЕНИ пользователя-владельца … так „мозги“ этим ключом
 * делают ровно то, что можно самому пользователю, — не больше» (apiV1.js:29).
 * Списки целей и кампаний это обещание не выполняют: они объявлены как `(_req, res)`
 * и отдают всю платформу.
 */
test('GET /api/v1/goals и /campaigns: ключ отдаёт только данные своего пользователя', async () => {
  process.env.MURMEX_API_KEY = 'aii_live_sk_testkey_for_bob'
  process.env.MURMEX_API_KEY_OWNER = bob.id
  const { apiV1Router } = await import('../apiV1.js')
  const app = express()
  app.use(express.json())
  app.use('/api/v1', apiV1Router)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (url) => {
    const res = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${process.env.MURMEX_API_KEY}` } })
    return res.json()
  }
  try {
    const goals = await get('/api/v1/goals')
    assert.ok(!(goals.goals || []).some((g) => g.id === goalA.id), `ключ Боба вернул цель Алисы: ${JSON.stringify(goals.goals)}`)
    const camps = await get('/api/v1/campaigns')
    assert.ok(!(camps.campaigns || []).some((c) => c.id === campA.id), `ключ Боба вернул кампанию Алисы: ${JSON.stringify(camps.campaigns)}`)
  } finally {
    await new Promise((r) => server.close(r))
    delete process.env.MURMEX_API_KEY
    delete process.env.MURMEX_API_KEY_OWNER
  }
})

// ─────────────────────────── ГЕЙТ «ЧУЖОЙ АККАУНТ» ───────────────────────────

/**
 * Разрезать файл на тела обработчиков: ключ — «METHOD путь», значение — исходник
 * обработчика до следующего роута. Нужен, чтобы спросить «есть ли здесь гейт».
 * @param {string} src @param {string} prefix `app` или имя роутера
 */
function routeBodies(src, prefix) {
  const re = new RegExp(`${prefix}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g')
  const found = []
  let m
  while ((m = re.exec(src))) found.push({ method: m[1].toUpperCase(), route: m[2], start: m.index })
  return found.map((r, i) => ({
    ...r,
    body: src.slice(r.start, i + 1 < found.length ? found[i + 1].start : src.length),
  }))
}

test('роуты «по аккаунту» в server/index.js закрыты гейтом canSeeAccount', async () => {
  const src = await fs.readFile(srv('index.js'), 'utf8')
  const routes = routeBodies(src, 'app')
  // Всё, что читает или меняет КОНКРЕТНЫЙ аккаунт: id аккаунта не секрет (он в ссылках,
  // в логах задач, в ответе /api/tg/accounts/busy), поэтому без гейта чужой профиль,
  // его переписка и его статус доступны прямым запросом.
  const mustGuard = routes.filter((r) => /^\/api\/tg\/accounts\/:accountId/.test(r.route))
  assert.ok(mustGuard.length >= 5, 'ожидали найти роуты по :accountId — изменился формат файла?')
  /*
   * Заслон на ПРЕФИКСЕ пути засчитываем наравне с проверкой в каждом хендлере — и он
   * предпочтителен. Требовать `canSeeAccount` в теле каждого обработчика значит требовать
   * ровно того способа, которым дыра и завелась: полтора десятка роутов писались в разное
   * время, и в части из них проверку забыли. Заслон на `app.use(префикс)` забыть нельзя —
   * он действует и на роут, которого ещё нет.
   *
   * Проверяем оба условия: заслон зовёт `canSeeAccount` и объявлен ДО первого роута
   * (объявленный после — их не накрывает).
   */
  const use = /app\.use\(\s*'\/api\/tg\/accounts\/:accountId'\s*,\s*(\w+)\s*\)/.exec(src)
  if (use) {
    const declAt = src.indexOf(`const ${use[1]}`) >= 0 ? src.indexOf(`const ${use[1]}`) : src.indexOf(`function ${use[1]}`)
    assert.ok(declAt >= 0, `не нашли объявление заслона ${use[1]}`)
    assert.ok(/canSeeAccount/.test(src.slice(declAt, declAt + 900)), 'заслон на :accountId не зовёт canSeeAccount')
    assert.ok(use.index < Math.min(...mustGuard.map((r) => r.start)), 'заслон объявлен ПОСЛЕ роутов — они открыты')
    return
  }
  const unguarded = mustGuard
    .filter((r) => !/canSeeAccount/.test(r.body))
    .map((r) => `${r.method} ${r.route}`)
  assert.deepEqual(unguarded, [], `без проверки владельца аккаунта:\n  ${unguarded.join('\n  ')}`)
})

test('массовые операции по чужим аккаунтам в server/index.js проверяют владельца', async () => {
  const src = await fs.readFile(srv('index.js'), 'utf8')
  const routes = routeBodies(src, 'app')
  // Эти роуты принимают accountIds СПИСКОМ в теле — можно подставить чужие: отправить
  // чужие аккаунты «на отдых» (остановит работу клиента) или запустить на них задачу.
  const bulk = ['/api/accounts/activity', '/api/accounts/unblock']
  const unguarded = routes
    .filter((r) => r.method === 'POST' && bulk.includes(r.route))
    // `mineIds` — помощник в index.js: отсеивает чужие id тем же canSeeAccount.
    .filter((r) => !/canSeeAccount|mineIds|ownerScopeForRequest|accountBelongsTo/.test(r.body))
    .map((r) => `${r.method} ${r.route}`)
  assert.deepEqual(unguarded, [], `принимают чужие accountIds без проверки:\n  ${unguarded.join('\n  ')}`)
})

test('нейро-диалоги: чтение и ОТПРАВКА сообщений чужим аккаунтом закрыты гейтом', async () => {
  // Модульный гейт (`moduleAccessGuard`) проверяет только «оплачен ли модуль», а не
  // «твой ли это аккаунт». Без canSeeAccount любой клиент с оплаченным модулем читает
  // переписку чужих Telegram-аккаунтов и пишет от их имени.
  const src = await fs.readFile(srv('neuroDialogs/routes.js'), 'utf8')
  // Здесь заслон стоит на ПАРАМЕТРЕ маршрута — он накрывает все роуты с `:accountId`
  // разом, включая будущие. Роуты, где аккаунт приходит не параметром (`/inbox` со
  // списком в query), проверяются отдельно — с них требуем гейт в теле.
  const byParam = /neuroDialogsRouter\.param\(\s*'accountId'[\s\S]{0,700}/.exec(src)
  const paramGuarded = !!byParam && /canSeeAccount/.test(byParam[0])
  const unguarded = routeBodies(src, 'neuroDialogsRouter')
    .filter((r) => !(paramGuarded && /:accountId/.test(r.route)))
    .filter((r) => !/canSeeAccount/.test(r.body))
    .map((r) => `${r.method} ${r.route}`)
  assert.deepEqual(unguarded, [], `работают с любым accountId:\n  ${unguarded.join('\n  ')}`)
})

test('переписка лида читается только своим аккаунтом', async () => {
  // GET /api/leads/conversation?peer=…&accountId=… открывает диалог ЛЮБЫМ аккаунтом
  // платформы: достаточно знать id. Это прямое чтение чужих личных переписок.
  const src = await fs.readFile(srv('leadsRoutes.js'), 'utf8')
  const unguarded = routeBodies(src, 'leadsRouter')
    .filter((r) => /conversation/.test(r.route))
    .filter((r) => !/canSeeAccount/.test(r.body))
    .map((r) => `${r.method} ${r.route}`)
  assert.deepEqual(unguarded, [], `читают переписку любым аккаунтом:\n  ${unguarded.join('\n  ')}`)
})

test('глобальные настройки ИИ и чёрный список меняет только админ', async () => {
  // Один системный промпт и один ЧС на всю платформу: запись без гейта означает, что
  // любой клиент правит поведение ИИ и списки целей у ВСЕХ остальных.
  const src = await fs.readFile(srv('featureRoutes.js'), 'utf8')
  const global = ['/ai-settings', '/ai-safety', '/target-blacklist']
  const unguarded = routeBodies(src, 'featureRouter')
    .filter((r) => r.method !== 'GET' && global.includes(r.route))
    .filter((r) => !/isAdminRequest/.test(r.body))
    .map((r) => `${r.method} ${r.route}`)
  assert.deepEqual(unguarded, [], `меняются любым клиентом:\n  ${unguarded.join('\n  ')}`)
})
