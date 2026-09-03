/**
 * §10.3: публичный API v1 для внешнего AI-оркестратора («мозги»).
 *
 * Всё под закрытым ключом (Authorization: Bearer aii_live_sk_…). Даёт то, что
 * просили на созвоне 27.07:
 *  1) создавать цели / кампании / задачи модулей по ключу;
 *  2) спрашивать, ЧТО умеет каждый модуль (capabilities) — тот же ответ пригоден
 *     как MCP-манифест инструментов;
 *  3) до запуска отдавать estimate (стоимость + время).
 *
 * Слой тонкий: переиспользует те же серверные функции, что и UI (createGoal,
 * createCampaign, startModuleTask, effectivePrices) — один источник правды, а не
 * второй путь мимо валидаций.
 */
import { Router } from 'express'
import { requireApiKey } from './apiKeys.js'
import { MODULE_DEFS, listModuleKeys, startModuleTask } from './modules/registry.js'
import { moduleTitle } from './lib/moduleTitles.js'
import { describeModule, getDescriptor, listDescriptorKeys, summarizeModule } from './mcp/descriptors/index.js'
import {
  mcpPostHandler, mcpDeleteHandler, wantsEventStream, checkHttpPreconditions,
  RESOURCE_TEMPLATES,
} from './mcp/server.js'
import {
  SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS, serverCapabilities,
} from './mcp/protocol.js'
import { TOOLS } from './mcp/tools.js'
import { PROMPTS } from './mcp/prompts.js'
import { MCP_RESOURCE_PATH } from './mcp/wellKnown.js'
import { MCP_DOCS_PATH, docsEnabled } from './mcp/docs.js'
import { listServiceKeys as SERVICE_KEYS_FN } from './mcp/capabilities.js'

/** Ключи подсистем — для манифеста; сам список живёт в реестре возможностей. */
const SERVICE_KEYS = SERVICE_KEYS_FN()

export const apiV1Router = Router()

apiV1Router.use(requireApiKey())

// Ключ действует ОТ ИМЕНИ пользователя-владельца: подставляем его в x-user-id, чтобы
// весь RBAC (доступ к модулям/аккаунтам) применялся к нему. Так «мозги» этим ключом
// делают ровно то, что можно самому пользователю, — не больше.
apiV1Router.use((req, _res, next) => {
  if (req.apiKey?.ownerId) req.headers['x-user-id'] = req.apiKey.ownerId
  next()
})

/**
 * Собрать «что умеет модуль» — из дефинишенов + эффективных цен.
 *
 * Где есть MCP-дескриптор, отдаём полную схему; где нет — честно помечаем
 * `schema: 'partial'`. Раньше ответ выглядел одинаково полным для всех модулей,
 * и «мозги» принимали 5 полей за исчерпывающий список при реальных 32 (созвон 14.08).
 */
async function capabilities() {
  const { effectivePrices } = await import('./priceStore.js')
  const eff = await effectivePrices()
  const priceOf = (k) => eff.modules.find((m) => m.key === k) || { month: 0, action: 0 }
  return listModuleKeys().map((key) => {
    const def = MODULE_DEFS[key]
    const p = priceOf(key)
    const desc = getDescriptor(key)
    return {
      key,
      title: moduleTitle(key),
      requiresTargets: !!def.requiresTargets,
      targetLabel: def.targetLabel || null,
      // Главное поле для оркестратора: можно ли доверять этому описанию как полному.
      schema: desc ? 'full' : 'partial',
      schemaVersion: desc?.version ?? null,
      summary: desc?.whoAmI?.summary || null,
      tags: desc?.tags || [],
      describe: desc ? `/api/v1/modules/${key}/describe` : null,
      pricing: { subscriptionPerMonth: p.month, perAction: p.action, currency: eff.currency || '$' },
      run: {
        method: 'POST',
        path: `/api/v1/modules/${key}/run`,
        note: desc
          ? 'Полный список полей и ограничений — по ссылке describe. Доступны только аккаунты пользователя ключа (иначе 403).'
          : 'ВНИМАНИЕ: схема этого модуля ещё не описана — перечислены только общие поля, модуль принимает больше. '
            + 'Доступны только аккаунты пользователя ключа (иначе 403).',
        body: {
          accountIds: 'string[] — аккаунты, которыми работать (из доступных пользователю)',
          ...(def.requiresTargets ? { targets: `string[] — ${def.targetLabel || 'цели'} (обязательно)` } : {}),
          maxActions: 'number — сколько действий (лимит)',
          goalId: 'string? — под какой целью',
          campaignId: 'string? — под какой кампанией',
        },
      },
    }
  })
}

/**
 * §10.3(2): возможности платформы. Четыре среза, чтобы оркестратор спрашивал ровно то,
 * что ему нужно, а не разбирал один большой ответ ради одного поля.
 *
 *   GET /capabilities                  — всё сразу: модули + сервисы + сам пользователь
 *   GET /capabilities/modules          — только модули
 *   GET /capabilities/services         — только подсистемы (прокси, аккаунты, задачи…)
 *   GET /capabilities/users            — пользователи (чужие — только админу/сервису)
 *   GET /capabilities/<kind>/<id>      — одна конкретная возможность любого вида
 *
 * Совместимость: корневой ответ по-прежнему содержит `modules` В ТОМ ЖЕ ВИДЕ, что и
 * раньше (плюс новые поля). Им уже пользуются, ломать нельзя.
 */
apiV1Router.get('/capabilities', async (req, res) => {
  try {
    const { allCapabilities } = await import('./mcp/capabilities.js')
    const all = await allCapabilities({ req })
    // Прежняя форма модуля добавляется рядом с новой: старый потребитель читает
    // `modules[].run.body` и `describe` как строку, новый — `access` и `pricing`.
    // `run` и `describe` сливаем поимённо, а не целиком: наивный спред затирал
    // legacy-`run.body` новым объектом и молча ломал совместимость.
    const legacyByKey = new Map((await capabilities()).map((m) => [m.key, m]))
    res.json({
      ok: true,
      ...all,
      modules: all.modules.map((m) => {
        const legacy = legacyByKey.get(m.key)
        return {
          ...legacy,
          ...m,
          describe: legacy?.describe ?? m.describe,
          run: { ...(legacy?.run || {}), ...m.run },
        }
      }),
    })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** Только модули. */
apiV1Router.get('/capabilities/modules', async (req, res) => {
  try {
    const { listModuleCapabilities } = await import('./mcp/capabilities.js')
    const modules = await listModuleCapabilities({ req })
    res.json({ ok: true, kind: 'module', total: modules.length, allowed: modules.filter((m) => m.access.allowed).length, modules })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** Только подсистемы: прокси, менеджер аккаунтов, дашборд задач, статистика и прочие. */
apiV1Router.get('/capabilities/services', async (req, res) => {
  try {
    const { listServiceCapabilities } = await import('./mcp/capabilities.js')
    const services = await listServiceCapabilities({ req })
    res.json({ ok: true, kind: 'service', total: services.length, allowed: services.filter((s) => s.access.allowed).length, services })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** Только пользователь. Без id — тот, от чьего имени работает ключ. */
apiV1Router.get('/capabilities/user', async (req, res) => {
  try {
    const { getUserCapability } = await import('./mcp/capabilities.js')
    const r = await getUserCapability('me', { req })
    if (r.error) return res.status(r.status).json({ ok: false, error: r.error })
    res.json({ ok: true, kind: 'user', user: r.capability })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** Список пользователей: чужих видит только админский или сервисный ключ. */
apiV1Router.get('/capabilities/users', async (req, res) => {
  try {
    const { listUserCapabilities } = await import('./mcp/capabilities.js')
    const users = await listUserCapabilities({ req })
    res.json({ ok: true, kind: 'user', total: users.length, users })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * Одна конкретная возможность. `kind` — `modules` / `services` / `users`;
 * для пользователя `me` означает владельца ключа.
 */
apiV1Router.get('/capabilities/:kind/:id', async (req, res) => {
  try {
    const caps = await import('./mcp/capabilities.js')
    const kind = caps.KIND_BY_PLURAL[req.params.kind]
    if (!kind) {
      return res.status(404).json({
        ok: false,
        error: `Unknown capability kind "${req.params.kind}". Available: ${Object.keys(caps.KIND_BY_PLURAL).join(', ')}.`,
      })
    }
    const id = req.params.id

    if (kind === 'user') {
      const r = await caps.getUserCapability(id, { req })
      if (r.error) return res.status(r.status).json({ ok: false, error: r.error })
      return res.json({ ok: true, kind, capability: r.capability })
    }

    const capability = kind === 'module'
      ? await caps.getModuleCapability(id, { req })
      : await caps.getServiceCapability(id, { req })
    if (!capability) {
      const known = kind === 'module' ? listModuleKeys() : caps.listServiceKeys()
      return res.status(404).json({ ok: false, error: `Unknown ${kind} "${id}". Available: ${known.join(', ')}.` })
    }
    res.json({ ok: true, kind, capability })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * Полное описание модуля для «мозгов»: все параметры, ограничения, блоки, пресеты,
 * примеры и машинная JSON Schema входа. Собирается из дескриптора
 * (`server/mcp/descriptors/`), а он сверяется с кодом contract-тестом.
 *
 * До готовности MCP-транспорта (этап 2) это способ посмотреть результат обычным curl.
 */
apiV1Router.get('/modules/:key/describe', (req, res) => {
  const key = req.params.key
  if (!MODULE_DEFS[key]) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
  const module = describeModule(key)
  if (!module) {
    // Не выдумываем описание для неописанного модуля: пустая правда полезнее
    // правдоподобной выдумки — на ней «мозги» уже один раз построили нерабочие задачи.
    return res.status(404).json({
      ok: false,
      error: `Схема модуля «${key}» ещё не описана`,
      described: listDescriptorKeys(),
    })
  }
  res.json({ ok: true, module })
})

/** Список модулей с пометкой, у каких схема полная. */
apiV1Router.get('/modules', async (_req, res) => {
  try {
    const caps = await capabilities()
    res.json({
      ok: true,
      described: listDescriptorKeys().length,
      total: caps.length,
      modules: caps.map((c) => ({
        key: c.key,
        title: c.title,
        schema: c.schema,
        summary: c.summary,
        describe: c.describe,
        // Сколько полей описано — «мозгам» видно, что за модулем стоит реальная схема,
        // а не заглушка, ещё до перехода по ссылке.
        paramCount: summarizeModule(c.key)?.paramCount ?? null,
      })),
    })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * Человекочитаемый срез MCP-эндпоинта: «что тут вообще есть», открывается curl'ом.
 *
 * ВАЖНО, ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ. Раньше этот ответ строил СВОЙ список `tools`
 * (`whoami`, `run_neuro_commenting`, `create_goal`…), которого не существует в
 * MCP-сервере: настоящие инструменты называются иначе. Получилось два источника правды
 * об одном и том же — ровно та болезнь, ради лечения которой заведён весь раздел.
 * Модель, прочитавшая манифест, вызывала `run_neuro_commenting` и получала
 * «Unknown tool».
 *
 * Теперь `tools` берётся из того же массива `TOOLS`, что отдаёт `tools/list`, а
 * REST-маршруты живут отдельным полем `restEndpoints` и инструментами не притворяются.
 */
apiV1Router.get('/mcp', async (req, res) => {
  try {
    // Клиент пришёл открывать SSE-поток. Мы его не держим — спецификация обязывает
    // ответить 405, иначе клиент примет наш JSON-манифест за открытый поток.
    if (wantsEventStream(req)) {
      return res.status(405).json({
        error: 'This endpoint does not serve an SSE stream: the server never initiates messages. '
          + 'Use POST for JSON-RPC, or GET without Accept: text/event-stream for this manifest.',
      })
    }
    const bad = checkHttpPreconditions(req)
    if (bad) return res.status(bad.status).json(bad.body)

    const caps = await capabilities()
    const { resourceUri, resourceMetadataUrl } = await import('./mcp/wellKnown.js')
    res.json({
      ok: true,
      name: SERVER_INFO.name,
      serverInfo: SERVER_INFO,
      note: 'Human-readable view. The protocol itself is JSON-RPC 2.0 over POST on this same URL.',
      mcp: {
        endpoint: MCP_RESOURCE_PATH,
        resource: resourceUri(req),
        transport: 'streamable-http (JSON-RPC 2.0 over POST)',
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        modernVersions: MODERN_VERSIONS,
        legacyVersions: LEGACY_VERSIONS,
        // Две эры на одном адресе: новые клиенты идут без рукопожатия и обязаны слать
        // `_meta`, старые — через `initialize`. Клиенту важно знать, что доступны обе.
        eras: {
          modern: 'No handshake. Every request carries _meta["io.modelcontextprotocol/protocolVersion"] and clientCapabilities. Call server/discover first if you want the version list up front.',
          legacy: 'Classic initialize + notifications/initialized handshake, for revisions 2025-11-25 and earlier.',
        },
        capabilities: serverCapabilities(),
        auth: {
          scheme: 'Authorization: Bearer <api-key>',
          resourceMetadata: resourceMetadataUrl(req),
        },
        // Живая документация: та же информация, но глазами и с кнопкой «выполнить».
        // Отдаём адрес прямо здесь — иначе о ней узнают из README, а README читают последним.
        docs: docsEnabled() ? new URL(MCP_DOCS_PATH, resourceUri(req)).href : null,
      },
      coverage: { described: listDescriptorKeys().length, total: caps.length },
      // Единственный список инструментов на весь сервер — тот же, что в tools/list.
      tools: TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      })),
      prompts: PROMPTS,
      resourceTemplates: RESOURCE_TEMPLATES,
      // REST-маршруты — не инструменты MCP. Они существуют, ими пользуются, но вызывать
      // их надо обычным HTTP, а не `tools/call`, и путать одно с другим нельзя.
      restEndpoints: [
        { method: 'GET', path: '/api/v1/me', description: 'Which product user this key acts as.' },
        { method: 'GET', path: '/api/v1/modules', description: 'Modules with a flag showing whether the schema is complete.' },
        { method: 'GET', path: '/api/v1/modules/:key/describe', description: `Full module description. Described modules: ${listDescriptorKeys().join(', ')}.` },
        { method: 'GET', path: '/api/v1/capabilities', description: 'Everything at once: modules, platform services and the key owner, each with whether it is allowed.' },
        { method: 'GET', path: '/api/v1/capabilities/modules', description: 'Campaign modules only, with pricing and per-block permissions.' },
        { method: 'GET', path: '/api/v1/capabilities/services', description: `Platform subsystems only: ${SERVICE_KEYS.join(', ')}.` },
        { method: 'GET', path: '/api/v1/capabilities/user', description: 'The key owner: roles, permissions, balance.' },
        { method: 'GET', path: '/api/v1/capabilities/users', description: 'All users (admin or service key only; a scoped key sees itself).' },
        { method: 'GET', path: '/api/v1/capabilities/:kind/:id', description: 'One capability. kind = modules | services | users; "me" means the key owner.' },
        { method: 'POST', path: '/api/v1/modules/:key/estimate', description: 'Cost and time before launch.' },
        { method: 'POST', path: '/api/v1/modules/:key/run', description: 'Start a module task over plain REST.' },
        { method: 'GET,POST', path: '/api/v1/goals', description: 'List or create goals.' },
        { method: 'GET,POST', path: '/api/v1/campaigns', description: 'List or create campaigns.' },
      ],
    })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * Точка входа MCP-протокола. Тот же путь, что у манифеста: GET — посмотреть глазами,
 * POST — говорить по JSON-RPC. Авторизация общая (`requireApiKey` на весь роутер),
 * права — владельца ключа, как и у остального API.
 */
apiV1Router.post('/mcp', mcpPostHandler)
apiV1Router.delete('/mcp', mcpDeleteHandler)

/**
 * §10.3(1): цели и кампании.
 *
 * Обещание выше («ключ делает ровно то, что можно самому пользователю») эти четыре
 * роута не выполняли: списки были объявлены как `(_req, res)` и отдавали цели и
 * кампании ВСЕЙ платформы — чужие стратегии, метрики и состав кампаний уходили по
 * одному ключу. Создание же не проставляло владельца, и запись получалась «ничьей»:
 * в кабинете её потом не видел никто, кроме админа.
 *
 * Владельца берём из ключа (`req.apiKey.ownerId`), а не из тела: иначе внешний
 * оркестратор мог бы записать цель на чужого пользователя. Системный env-ключ владельца
 * не имеет — он служебный, ему по-прежнему видно всё (x-user-id не подставляется,
 * `ownedForRequest` отдаёт полный список).
 */
apiV1Router.get('/goals', async (req, res) => {
  try {
    const { listGoals } = await import('./goals.js')
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    res.json({ ok: true, goals: await ownedForRequest(req, await listGoals()) })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/goals', async (req, res) => {
  try {
    const { createGoal } = await import('./goals.js')
    const goal = await createGoal({ ...(req.body || {}), userId: req.apiKey?.ownerId || undefined })
    res.json({ ok: true, goal })
  } catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

apiV1Router.get('/campaigns', async (req, res) => {
  try {
    const { listCampaigns } = await import('./campaigns.js')
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    res.json({ ok: true, campaigns: await ownedForRequest(req, await listCampaigns()) })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/campaigns', async (req, res) => {
  try {
    const { createCampaign } = await import('./campaigns.js')
    const campaign = await createCampaign({ ...(req.body || {}), userId: req.apiKey?.ownerId || undefined })
    res.json({ ok: true, campaign })
  } catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

/** §10.3 + §10.1: estimate стоимости и времени ДО запуска. */
apiV1Router.post('/modules/:key/estimate', async (req, res) => {
  try {
    const key = req.params.key
    if (!MODULE_DEFS[key]) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
    const actions = Math.max(0, Math.round(Number(req.body?.actions) || 0))
    const accounts = Math.max(1, Math.round(Number(req.body?.accounts) || 1))
    const { effectivePrices } = await import('./priceStore.js')
    const eff = await effectivePrices()
    const perAction = eff.actionMap[key] || 0
    const actionsCost = Math.round(perAction * actions * 1000) / 1000
    // Время: действия делятся между аккаунтами, задержка 30–120 c (как в модулях).
    const perAcc = Math.ceil(actions / accounts)
    const time = { minSec: perAcc * 30, maxSec: perAcc * 120 }
    res.json({
      ok: true,
      module: key,
      actions,
      accounts,
      cost: { actionsCoins: actionsCost, currency: eff.currency || '$', note: 'Токены ИИ добавятся по факту — их расход заранее неизвестен.' },
      time,
    })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * Кто «я» (какой пользователь продукта стоит за ключом). «Мозги» спрашивают это,
 * чтобы понимать, от чьего имени и с какими правами работают.
 */
apiV1Router.get('/me', async (req, res) => {
  try {
    const userId = req.apiKey?.ownerId
    // Системный env-ключ без владельца — не пользователь, а сервис (полный доступ).
    if (!userId) {
      return res.json({ ok: true, user: { id: 'system', name: 'Сервисный ключ (env)', role: 'system', service: true } })
    }
    const { getUser, publicUser } = await import('./users.js')
    const user = await getUser(userId).catch(() => null)
    if (!user) return res.status(404).json({ ok: false, error: 'Пользователь ключа не найден' })
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * §10.3(3): запуск модуля. Та же функция, что у UI, — валидации те же.
 *
 * Ключ действует ОТ ИМЕНИ пользователя (x-user-id уже подставлен). Аккаунты берём из
 * запроса, но каждый проверяем: доступен ли он этому пользователю по его роли —
 * чужой аккаунт → 403. Так ключ работает только с тем, что можно самому человеку.
 */
apiV1Router.post('/modules/:key/run', async (req, res) => {
  try {
    const key = req.params.key
    if (!MODULE_DEFS[key]) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
    // Нужен либо владелец (ключ пользователя), либо системный env-ключ (полный доступ).
    if (!req.apiKey?.ownerId && !req.apiKey?.service) return res.status(400).json({ ok: false, error: 'Ключ не привязан к пользователю' })
    const accountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : []
    if (!accountIds.length) return res.status(400).json({ ok: false, error: 'Укажите accountIds — аккаунты, которыми работать' })
    // Каждый аккаунт должен быть доступен пользователю ключа (RBAC по роли).
    const { canSeeAccount } = await import('./lib/accessGuard.js')
    for (const id of accountIds) {
      if (!(await canSeeAccount(req, id))) {
        return res.status(403).json({ ok: false, error: `Аккаунт ${id} недоступен пользователю этого ключа` })
      }
    }
    const settings = { ...(req.body || {}), accountIds, initiator: 'api' }
    const { store, task, worker } = startModuleTask(key, settings)
    // Тот же порядок, что и в UI-роуте: СНАЧАЛА запись, потом запуск. `startWorker`
    // поднимает задачу из хранилища по id; без сохранения он не находит её и молча
    // ничего не делает — задача получала id и никогда не выполнялась.
    await store.saveTask(task)
    const { startWorker } = await import('./modules/workers.js')
    startWorker(task.id, store, worker)
    res.json({ ok: true, taskId: task.id, module: key, status: task.status })
  } catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

function msg(err) { return err instanceof Error ? err.message : 'Ошибка' }
