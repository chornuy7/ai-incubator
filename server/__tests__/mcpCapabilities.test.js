/**
 * Слой возможностей: «что тут есть и что из этого МНЕ разрешено».
 *
 * Четыре среза, ради которых он заведён: всё сразу, только модули, только пользователь и
 * одна конкретная возможность любого вида. Раньше на этот вопрос отвечал единственный
 * `/api/v1/capabilities`, и отвечал только про модули — оркестратор не знал ни про
 * прокси, ни про дашборд задач, ни про собственные права, и упирался в 403 на первом шаге.
 *
 * Проверяем на РЕАЛЬНЫХ ролях и пользователях во временных файлах: вся суть слоя — в
 * связке «пользователь → роли → право», чистой функцией её не покрыть. Пути модулей
 * резолвятся на импорте, поэтому env выставляем ДО первого импорта.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

const dir = path.join(os.tmpdir(), `caps-${process.pid}-${Math.random().toString(36).slice(2)}`)
await fs.mkdir(dir, { recursive: true })
process.env.DATA_DIR = dir
process.env.ROLES_FILE = path.join(dir, 'roles.json')
process.env.USERS_FILE = path.join(dir, 'users.json')

const caps = await import('../mcp/capabilities.js')
const { callTool, TOOLS } = await import('../mcp/tools.js')
const { SECTIONS } = await import('../roles.js')
const { listModuleKeys } = await import('../modules/registry.js')

/** Контекст сервисного ключа: владельца нет — это система, а не пользователь. */
const SYSTEM = { req: { apiKey: { id: 'env', service: true, ownerId: '' }, headers: {}, header: () => undefined } }
/** Контекст ключа, действующего от имени конкретного пользователя. */
const asUser = (id) => ({
  req: {
    apiKey: { id: 'k', ownerId: id },
    headers: { 'x-user-id': id },
    header: (h) => (h.toLowerCase() === 'x-user-id' ? id : undefined),
  },
})

// ── Каталог сервисов ───────────────────────────────────────────────────────────

test('сервисы опираются на SECTIONS, а не на выдуманный рядом список', () => {
  // Второй список «что у нас есть» немедленно разойдётся с тем, по которому реально
  // выдаётся доступ, и `allowed` начнёт врать.
  const known = new Set(SECTIONS.map((s) => s.key))
  for (const svc of caps.SERVICES) {
    if (svc.section === null) continue
    assert.ok(known.has(svc.section), `сервис «${svc.key}» ссылается на несуществующий раздел ${svc.section}`)
  }
})

test('каталог сервисов покрывает подсистемы, названные заказчиком', () => {
  const keys = caps.listServiceKeys()
  for (const k of ['proxies', 'accounts', 'tasks', 'analytics', 'my-statistics']) {
    assert.ok(keys.includes(k), `нет сервиса «${k}»`)
  }
  assert.equal(new Set(keys).size, keys.length, 'ключи сервисов обязаны быть уникальны')
})

test('каждый сервис объясняет себя так же полно, как модуль', () => {
  for (const svc of caps.SERVICES) {
    assert.ok(svc.title && svc.summary, `${svc.key}: нет названия или сводки`)
    // doesNot у сервиса нужен ровно затем же, зачем у модуля: без него оркестратор
    // регулярно ждёт от подсистемы того, чего она не делает.
    assert.ok(svc.does?.length, `${svc.key}: не описано, что подсистема делает`)
    assert.ok(svc.doesNot?.length, `${svc.key}: не описано, чего она НЕ делает`)
    assert.ok(svc.endpoints?.length, `${svc.key}: не перечислены эндпоинты`)
    for (const e of svc.endpoints) {
      assert.match(e.path, /^\/api\//, `${svc.key}: эндпоинт «${e.path}» не похож на реальный путь`)
      assert.ok(e.method && e.title, `${svc.key}: эндпоинт без метода или описания`)
    }
  }
})

// ── Четыре среза ───────────────────────────────────────────────────────────────

test('срез «всё сразу»: модули + сервисы + сам пользователь', async () => {
  const all = await caps.allCapabilities(SYSTEM)

  assert.equal(all.modules.length, listModuleKeys().length)
  assert.equal(all.services.length, caps.SERVICES.length)
  assert.ok(all.user, 'владелец ключа обязан быть в ответе')
  assert.equal(all.counts.modules, all.modules.length)
  assert.equal(all.viewer.isService, true)
  // Список ВСЕХ пользователей платформы в ответе «что я умею» не нужен и был бы
  // утечкой по умолчанию — за ним идут отдельным запросом.
  assert.equal('users' in all, false)
})

test('срез «только модули» и «только сервисы»', async () => {
  const modules = await caps.listModuleCapabilities(SYSTEM)
  assert.equal(modules.length, listModuleKeys().length)
  assert.ok(modules.every((m) => m.kind === 'module' && m.access && m.pricing))

  const services = await caps.listServiceCapabilities(SYSTEM)
  assert.ok(services.every((s) => s.kind === 'service' && s.access))
})

test('срез «только пользователь»: сервисный ключ — это система, а не запись в БД', async () => {
  const r = await caps.getUserCapability('me', SYSTEM)
  assert.equal(r.capability.kind, 'user')
  assert.equal(r.capability.id, 'system')
  assert.equal(r.capability.unrestricted, true)
  // «Не ограничен» говорим словом. `null` в правах один раз уже прочитали как
  // «прав нет» и закрыли человеку всё меню (правка 18.08).
  assert.equal(Object.values(r.capability.access.modules).every(Boolean), true)
})

test('срез «одна возможность»: модуль, сервис и пользователь по ключу', async () => {
  const mod = await caps.getModuleCapability('mailing', SYSTEM)
  assert.equal(mod.key, 'mailing')
  assert.equal(mod.schema, 'full')
  assert.ok(mod.paramCount >= 17, 'счётчик полей берётся из дескриптора')

  const svc = await caps.getServiceCapability('proxies', SYSTEM)
  assert.equal(svc.section, '/panel/proxies')
  // Раздел клиент получает КЛЮЧОМ: русская подпись из SECTIONS наружу не уезжает
  // (правило «MCP только по-английски»), а право выдаётся именно по ключу.
  assert.equal('sectionLabel' in svc, false)

  assert.equal(await caps.getModuleCapability('нет-такого', SYSTEM), null)
  assert.equal(await caps.getServiceCapability('нет-такого', SYSTEM), null)
})

// ── Права ──────────────────────────────────────────────────────────────────────

test('access считается по НАСТОЯЩИМ правам роли, а не выдаётся всем', async () => {
  const { createUser } = await import('../users.js')
  const { createRole, updateRole, ADMIN_ROLE_ID } = await import('../roles.js')

  const limited = await createRole({ name: 'Только комментинг и прокси', permissions: {} })
  await updateRole(limited.id, {
    permissions: {
      modules: { 'neuro-commenting': 'allow' },
      blocks: { 'neuro-commenting:run': 'allow', 'neuro-commenting:logs': 'allow' },
      sections: { '/panel/proxies': 'allow' },
    },
  })
  const worker = await createUser({ email: `w${Date.now()}@t.io`, password: 'x12345', roleIds: [limited.id] })
  const admin = await createUser({ email: `a${Date.now()}@t.io`, password: 'x12345', roleIds: [ADMIN_ROLE_ID] })

  const mods = await caps.listModuleCapabilities(asUser(worker.id))
  const byKey = Object.fromEntries(mods.map((m) => [m.key, m]))
  assert.equal(byKey['neuro-commenting'].access.allowed, true)
  assert.equal(byKey.mailing.access.allowed, false, 'модуль без права роли обязан быть закрыт')
  // Блоки внутри модуля — отдельная ось: «запустить можно, настройки — нет».
  assert.equal(byKey['neuro-commenting'].access.blocks.run, true)
  assert.equal(byKey['neuro-commenting'].access.blocks.settings, false)
  assert.match(byKey.mailing.access.reason, /not granted/i, 'отказ обязан объяснять причину')

  const svcs = await caps.listServiceCapabilities(asUser(worker.id))
  const svcByKey = Object.fromEntries(svcs.map((s) => [s.key, s]))
  assert.equal(svcByKey.proxies.access.allowed, true)
  assert.equal(svcByKey.tasks.access.allowed, false, 'раздел без права роли закрыт')
  // Баланс гейта не имеет по устройству — он доступен всем.
  assert.equal(svcByKey.billing.access.allowed, true)

  // Админ проходит везде, и это отдельная ветка (`permissions === null`).
  const adminMods = await caps.listModuleCapabilities(asUser(admin.id))
  assert.equal(adminMods.every((m) => m.access.allowed), true)
})

test('чужого пользователя читает только админский или сервисный ключ', async () => {
  const { createUser } = await import('../users.js')
  const { createRole, ADMIN_ROLE_ID } = await import('../roles.js')
  const role = await createRole({ name: 'Обычная', permissions: {} })
  const a = await createUser({ email: `x${Date.now()}@t.io`, password: 'x12345', roleIds: [role.id] })
  const b = await createUser({ email: `y${Date.now()}@t.io`, password: 'x12345', roleIds: [role.id] })
  const admin = await createUser({ email: `z${Date.now()}@t.io`, password: 'x12345', roleIds: [ADMIN_ROLE_ID] })

  const own = await caps.getUserCapability('me', asUser(a.id))
  assert.equal(own.capability.id, a.id, 'себя читать можно всегда')

  const foreign = await caps.getUserCapability(b.id, asUser(a.id))
  assert.equal(foreign.status, 403)
  assert.match(foreign.error, /may only read its own capabilities/i)

  assert.equal((await caps.getUserCapability(b.id, asUser(admin.id))).capability.id, b.id, 'админу — можно')
  assert.equal((await caps.getUserCapability(b.id, SYSTEM)).capability.id, b.id, 'сервисному ключу — можно')

  // Список: ключ под пользователем видит ровно себя и никого больше.
  const scoped = await caps.listUserCapabilities(asUser(a.id))
  assert.deepEqual(scoped.map((u) => u.id), [a.id])
  assert.ok((await caps.listUserCapabilities(SYSTEM)).length > 1)

  const missing = await caps.getUserCapability('usr_нет', SYSTEM)
  assert.equal(missing.status, 404)
})

test('ключ удалённого пользователя не получает полный доступ по умолчанию', async () => {
  // Это ровно та ситуация, в которой отозванный сотрудник продолжает работать ключом.
  const v = await caps.resolveViewer(asUser('usr_которого_нет'))
  assert.equal(v.unrestricted, false)
  assert.equal(v.isAdmin, false)
  const mods = await caps.listModuleCapabilities(asUser('usr_которого_нет'))
  assert.equal(mods.every((m) => !m.access.allowed), true, 'fail-closed: ничего не разрешено')
})

test('возможности отдаются по-английски: витринные русские подписи наружу не уезжают', async () => {
  // Правило раздела (CLAUDE.md → «ЯЗЫК MCP»). Ловится тем, что рядом лежат две похожие
  // карты: `MODULE_TITLES` («Рассылка») и `SECTIONS[].label` («Прокси») — обе русские и
  // обе для панели. Они уже приезжали клиенту в `title` и `sectionLabel`.
  //
  // Имена пользователей и ролей сюда не входят: это данные, которые человек ввёл сам,
  // и переводить их нельзя. Поэтому проверяем модули и сервисы, а не список юзеров.
  const CYRILLIC = /[а-яё]/i
  const found = []
  const walk = (node, path) => {
    if (typeof node === 'string') { if (CYRILLIC.test(node)) found.push(`${path}: «${node.slice(0, 70)}»`) }
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
  }
  walk(await caps.listModuleCapabilities(SYSTEM), 'modules')
  walk(await caps.listServiceCapabilities(SYSTEM), 'services')

  assert.deepEqual(found, [], `Кириллица в ответе capabilities:
  ${found.join('\n  ')}`)

  // Заголовок обязан приходить из дескриптора, а не из витрины.
  const mailing = await caps.getModuleCapability('mailing', SYSTEM)
  assert.equal(mailing.title, 'Mailing')
  assert.equal(mailing.targetLabel, 'phone number', 'подпись цели — английская (targetLabelEn)')
  assert.equal(typeof mailing.usesAi, 'boolean', 'признак ИИ доезжает до карточки модуля')
  // Курс coinsPer1kTokens удалён из модели цен — обещать его нельзя.
  assert.equal('coinsPer1kTokens' in mailing.pricing, false)
})

// ── MCP-инструменты поверх того же реестра ─────────────────────────────────────

test('инструменты возможностей объявлены со схемами и аннотациями', () => {
  for (const name of ['list_capabilities', 'describe_capability']) {
    const t = TOOLS.find((x) => x.name === name)
    assert.ok(t, `нет инструмента ${name}`)
    assert.ok(t.outputSchema, `${name}: нет outputSchema`)
    assert.equal(t.annotations.readOnlyHint, true, `${name}: только читает`)
    assert.match(t.description, /Keywords:/i)
  }
  // Два похожих инструмента рядом — риск, что модель возьмёт не тот. Разница обязана
  // быть написана прямо в описании.
  assert.match(TOOLS.find((t) => t.name === 'list_modules').description, /list_capabilities/,
    'list_modules обязан отсылать к list_capabilities за правами')
})

test('list_capabilities: четыре среза через протокол', async () => {
  const all = await callTool('list_capabilities', {}, SYSTEM)
  assert.equal(all.kind, 'all')
  assert.ok(all.modules.length && all.services.length && all.user)

  const mods = await callTool('list_capabilities', { kind: 'module' }, SYSTEM)
  assert.equal(mods.kind, 'module')
  assert.equal('services' in mods, false, 'срез обязан отдавать только запрошенное')

  const svcs = await callTool('list_capabilities', { kind: 'service' }, SYSTEM)
  assert.equal(svcs.services.length, caps.SERVICES.length)

  const users = await callTool('list_capabilities', { kind: 'user' }, SYSTEM)
  assert.ok(users.users.length >= 1)
  assert.match(users.note, /read every user/i)
})

test('MCP и REST-реестр отдают ОДНО И ТО ЖЕ — источник правды один', async () => {
  // Разойдутся — и протокол пообещает доступ, которого REST не даст.
  const viaTool = await callTool('describe_capability', { kind: 'service', id: 'tasks' }, SYSTEM)
  const viaRegistry = await caps.getServiceCapability('tasks', SYSTEM)
  assert.deepEqual(viaTool, viaRegistry)

  const modTool = await callTool('describe_capability', { kind: 'module', id: 'warming' }, SYSTEM)
  assert.deepEqual(modTool, await caps.getModuleCapability('warming', SYSTEM))
})

test('describe_capability: неизвестный ключ отвечает списком существующих', async () => {
  await assert.rejects(
    () => callTool('describe_capability', { kind: 'service', id: 'нет-такого' }, SYSTEM),
    (e) => /Unknown service/i.test(e.message) && /Available services:/i.test(e.message),
  )
  await assert.rejects(
    () => callTool('describe_capability', { kind: 'module', id: 'нет-такого' }, SYSTEM),
    (e) => /Available modules:/i.test(e.message),
  )
  // Вид проверяется схемой входа, а не руками внутри обработчика.
  await assert.rejects(
    () => callTool('describe_capability', { kind: 'нечто', id: 'x' }, SYSTEM),
    (e) => /not allowed/i.test(e.message),
  )
})

test.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
