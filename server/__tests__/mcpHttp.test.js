/**
 * MCP на уровне HTTP: то, что нельзя проверить, вызывая handleMessage напрямую.
 *
 * Здесь ловятся дефекты транспорта, а не протокола: статус ответа, заголовки
 * авторизации, документ обнаружения, поведение GET/DELETE и битый JSON. Каждый пункт
 * ниже — «сервер ОБЯЗАН» из спецификации Streamable HTTP и раздела Authorization,
 * и почти каждый из них раньше не выполнялся: 401 приходил без WWW-Authenticate,
 * документа RFC 9728 не было вовсе, а битое тело отдавалось HTML-страницей express.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'

const KEY = 'test_service_key_for_mcp_http'
process.env.MURMEX_API_KEY = KEY
process.env.PUBLIC_BASE_URL = 'https://mcp.example.com'

const { apiV1Router } = await import('../apiV1.js')
const { mountWellKnown } = await import('../mcp/wellKnown.js')
const { MODERN_VERSIONS, META } = await import('../mcp/protocol.js')

const MODERN_META = {
  [META.PROTOCOL_VERSION]: MODERN_VERSIONS[0],
  [META.CLIENT_CAPABILITIES]: {},
}

/** Поднять приложение ровно так же, как это делает server/index.js. */
function buildApp() {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((err, req, res, next) => {
    if (!(err instanceof SyntaxError) || !('body' in err)) return next(err)
    if (!String(req.path || '').includes('/mcp')) return next(err)
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } })
  })
  mountWellKnown(app)
  app.use('/api/v1', apiV1Router)
  return app
}

let server
let base
test.before(async () => {
  server = http.createServer(buildApp())
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(() => server?.close())

const req = (path, opts = {}) => fetch(base + path, opts)

const rpc = (body, { auth = true, headers = {}, raw } = {}) => req('/api/v1/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(auth ? { authorization: `Bearer ${KEY}` } : {}),
    ...headers,
  },
  body: raw !== undefined ? raw : JSON.stringify(body),
})

// ── Авторизация и обнаружение ──────────────────────────────────────────────────

test('401 несёт WWW-Authenticate с адресом метаданных ресурса', async () => {
  // Без этого заголовка MCP-клиент не понимает НИЧЕГО: ни какой это ресурс, ни куда
  // идти за токеном. Текст в теле написан для человека, клиент его не разбирает.
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, { auth: false })
  assert.equal(r.status, 401)

  const challenge = r.headers.get('www-authenticate')
  assert.ok(challenge, 'заголовок обязателен по RFC 6750 / MCP § Authorization')
  assert.match(challenge, /^Bearer /)
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/api\/v1\/mcp"/)
})

test('негодный ключ отличается от отсутствующего: error="invalid_token"', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, { auth: false, headers: { authorization: 'Bearer nope' } })
  assert.equal(r.status, 401)
  assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/)
})

test('документ RFC 9728 доступен БЕЗ ключа и указывает канонический URI ресурса', async () => {
  // Он нужен ровно тем, у кого токена ещё нет: требовать ключ здесь — замкнутый круг.
  const r = await req('/.well-known/oauth-protected-resource/api/v1/mcp')
  assert.equal(r.status, 200)
  const doc = await r.json()
  assert.equal(doc.resource, 'https://mcp.example.com/api/v1/mcp')
  assert.deepEqual(doc.bearer_methods_supported, ['header'], 'токен в query-строке запрещён спецификацией')
  // Обещать OAuth-сервер, которого нет, хуже, чем не обещать: клиент потратит
  // раунд discovery и упрётся в 404.
  assert.equal('authorization_servers' in doc, false)

  const short = await req('/.well-known/oauth-protected-resource')
  assert.equal(short.status, 200, 'клиенты пробуют и краткую форму пути')
})

// ── Транспорт ──────────────────────────────────────────────────────────────────

test('POST JSON-RPC: 200 и корректный ответ протокола', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /application\/json/)
  const body = await r.json()
  assert.equal(body.result.resultType, 'complete')
  assert.ok(body.result.supportedVersions.includes(MODERN_VERSIONS[0]))
})

test('modern-ошибки приезжают с теми статусами, по которым клиент узнаёт эру', async () => {
  // Спецификация 2026-07-28 требует ИМЕННО этих статусов: по ним двухэрный клиент
  // решает, повторять запрос с другой версией или откатываться на initialize.
  const unknownMethod = await rpc({ jsonrpc: '2.0', id: 1, method: 'нет/такого', params: { _meta: MODERN_META } })
  assert.equal(unknownMethod.status, 404)
  assert.equal((await unknownMethod.json()).error.code, -32601)

  const badVersion = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { [META.PROTOCOL_VERSION]: '1999-01-01', [META.CLIENT_CAPABILITIES]: {} } },
  })
  assert.equal(badVersion.status, 400)
  assert.equal((await badVersion.json()).error.code, -32022)
})

test('legacy-ошибки остаются на 200 — старый клиент 404 не поймёт', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'нет/такого' })
  assert.equal(r.status, 200, 'legacy-эра таких требований к статусам не знала')
  assert.equal((await r.json()).error.code, -32601)
})

test('уведомление получает 202 без тела', async () => {
  const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(r.status, 202)
  assert.equal(await r.text(), '')
})

test('битый JSON — это -32700, а не HTML-страница express', async () => {
  const r = await rpc(null, { raw: '{"jsonrpc": "2.0", oops' })
  assert.equal(r.status, 400)
  assert.match(r.headers.get('content-type'), /application\/json/, 'клиент разбирает JSON, не HTML')
  const body = await r.json()
  assert.equal(body.error.code, -32700)
  assert.equal(body.id, null)
})

test('GET с Accept: text/event-stream → 405, обычный GET → манифест', async () => {
  const stream = await req('/api/v1/mcp', { headers: { authorization: `Bearer ${KEY}`, accept: 'text/event-stream' } })
  assert.equal(stream.status, 405, 'иначе клиент примет манифест за открытый поток')

  const manifest = await req('/api/v1/mcp', { headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' } })
  assert.equal(manifest.status, 200)
  const body = await manifest.json()
  assert.ok(body.mcp.protocolVersions.includes(MODERN_VERSIONS[0]))
  assert.ok(body.mcp.auth.resourceMetadata.endsWith('/.well-known/oauth-protected-resource/api/v1/mcp'))
})

test('манифест GET и tools/list описывают ОДИН набор инструментов', async () => {
  // Раньше манифест придумывал свои имена (`run_neuro_commenting`, `whoami`), которых
  // в протоколе нет: модель читала манифест и получала «Unknown tool».
  const manifest = await (await req('/api/v1/mcp', { headers: { authorization: `Bearer ${KEY}` } })).json()
  const listed = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } })).json()

  assert.deepEqual(
    manifest.tools.map((t) => t.name),
    listed.result.tools.map((t) => t.name),
    'два источника правды об инструментах — та самая болезнь, ради которой заведён раздел',
  )
  assert.ok(manifest.restEndpoints.length, 'REST-маршруты перечислены отдельно и инструментами не притворяются')
  assert.equal(manifest.restEndpoints.some((e) => /^run_/.test(e.path)), false)
})

test('DELETE → 405: сессий в протоколе больше нет', async () => {
  const r = await req('/api/v1/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(r.status, 405)
})

test('Origin чужого сайта отклоняется — защита от DNS rebinding', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, { headers: { origin: 'https://evil.example.com' } })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).jsonrpc, '2.0', 'тело — JSON-RPC ошибка, клиент разбирает один формат')
})

// ── Возможности: четыре среза ──────────────────────────────────────────────────

const getJson = async (path) => {
  const r = await req(path, { headers: { authorization: `Bearer ${KEY}` } })
  return { status: r.status, body: await r.json() }
}

test('GET /capabilities — всё сразу, и старая форма модулей сохранена', async () => {
  const { status, body } = await getJson('/api/v1/capabilities')
  assert.equal(status, 200)
  assert.ok(body.modules.length && body.services.length && body.user)
  assert.ok(body.counts.modules > 0)

  // Совместимость: этим ответом уже пользуются. Поля прежней формы обязаны остаться —
  // потребитель читает `run.body` и `describe` как строку.
  const m = body.modules[0]
  assert.ok(m.run.body, 'прежняя подсказка по телу запроса на месте')
  assert.equal(typeof m.describe, 'string', 'describe остаётся строкой-ссылкой, как раньше')
  // И одновременно приехало новое.
  assert.ok(m.access, 'новая ось: разрешено ли это ключу')
  assert.equal(m.kind, 'module')
})

test('GET /capabilities/modules и /capabilities/services — по отдельности', async () => {
  const mods = await getJson('/api/v1/capabilities/modules')
  assert.equal(mods.body.kind, 'module')
  assert.ok(mods.body.modules.length)
  assert.equal('services' in mods.body, false, 'срез отдаёт только запрошенное')
  assert.equal(typeof mods.body.allowed, 'number', 'сразу видно, сколько из них доступно')

  const svcs = await getJson('/api/v1/capabilities/services')
  assert.equal(svcs.body.kind, 'service')
  const keys = svcs.body.services.map((s) => s.key)
  for (const k of ['proxies', 'accounts', 'tasks', 'analytics']) assert.ok(keys.includes(k), `нет сервиса ${k}`)
})

test('GET /capabilities/user — владелец ключа; /capabilities/users — список', async () => {
  const me = await getJson('/api/v1/capabilities/user')
  assert.equal(me.body.kind, 'user')
  assert.ok(me.body.user.id, 'личность владельца ключа')
  assert.ok(me.body.user.access.services, 'какие подсистемы ему открыты')

  const list = await getJson('/api/v1/capabilities/users')
  assert.equal(list.body.kind, 'user')
  assert.ok(Array.isArray(list.body.users))
})

test('GET /capabilities/<kind>/<id> — одна возможность любого вида', async () => {
  const mod = await getJson('/api/v1/capabilities/modules/mailing')
  assert.equal(mod.body.capability.key, 'mailing')
  assert.equal(mod.body.capability.kind, 'module')

  const svc = await getJson('/api/v1/capabilities/services/proxies')
  assert.equal(svc.body.capability.section, '/panel/proxies')
  assert.ok(svc.body.capability.endpoints.length, 'подсистема перечисляет свои эндпоинты')

  const me = await getJson('/api/v1/capabilities/users/me')
  assert.equal(me.body.capability.kind, 'user')

  // Неизвестное — 404 со списком существующего, а не пустой ответ.
  const badId = await getJson('/api/v1/capabilities/services/нет-такого')
  assert.equal(badId.status, 404)
  assert.match(badId.body.error, /Available:/i)

  const badKind = await getJson('/api/v1/capabilities/нечто/x')
  assert.equal(badKind.status, 404)
  assert.match(badKind.body.error, /Unknown capability kind/i)
})

test('REST-срезы и MCP-инструмент строят ответ из одного реестра', async () => {
  // Разойдутся — и протокол пообещает доступ, которого REST не даст.
  const rest = await getJson('/api/v1/capabilities/services/tasks')
  const viaMcp = await (await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'describe_capability', arguments: { kind: 'service', id: 'tasks' }, _meta: MODERN_META },
  })).json()
  assert.deepEqual(viaMcp.result.structuredContent, rest.body.capability)
})

test('сквозной сценарий: discover → tools/list → describe_module → validate_task', async () => {
  const disc = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } })).json()
  assert.ok(disc.result.capabilities.tools)

  const tools = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } })).json()
  assert.ok(tools.result.tools.some((t) => t.name === 'describe_module'))

  const described = await (await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'describe_module', arguments: { module: 'mailing' }, _meta: MODERN_META },
  }, { headers: { 'mcp-method': 'tools/call', 'mcp-name': 'describe_module', 'mcp-protocol-version': MODERN_VERSIONS[0] } })).json()

  const schema = described.result.structuredContent.inputSchema
  assert.ok(schema.properties.targets, 'мейлинг обязан объявлять поле, по которому работает')

  // Собираем задачу ПО СХЕМЕ и убеждаемся, что сервер её принимает: именно это
  // «мозги» и делают, и именно здесь раньше рвался контракт.
  const validated = await (await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'validate_task',
      arguments: { module: 'mailing', settings: { accountIds: ['acc_1'], targets: ['@durov'], message: 'hi' } },
      _meta: MODERN_META,
    },
  }, { headers: { 'mcp-method': 'tools/call', 'mcp-name': 'validate_task', 'mcp-protocol-version': MODERN_VERSIONS[0] } })).json()

  const v = validated.result.structuredContent
  assert.equal(v.valid, true, JSON.stringify(v.errors))
})
