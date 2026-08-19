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
  SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS,
} from './mcp/server.js'

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

/** §10.3(2): что умеет каждый модуль. */
apiV1Router.get('/capabilities', async (_req, res) => {
  try { res.json({ ok: true, modules: await capabilities() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
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
 * MCP-манифест: те же возможности, оформленные как список инструментов. Внешний
 * оркестратор может брать отсюда tools, а вызывать — обычными POST ниже.
 *
 * Переходная форма: настоящий MCP-сервер (JSON-RPC 2.0 + Streamable HTTP) — этап 2
 * в docs/mcp/MCP-ROADMAP.md. Здесь важно другое: у модулей с дескриптором `input`
 * теперь настоящая JSON Schema с ограничениями, а не список строк-подсказок.
 */
apiV1Router.get('/mcp', async (req, res) => {
  try {
    // Клиент пришёл открывать SSE-поток. Мы его не держим — спецификация обязывает
    // ответить 405, иначе клиент примет наш JSON-манифест за открытый поток.
    if (wantsEventStream(req)) {
      return res.status(405).json({ error: 'SSE-поток не поддерживается: сервер не инициирует сообщения. Используйте POST.' })
    }
    const bad = checkHttpPreconditions(req)
    if (bad) return res.status(bad.status).json(bad.body)

    const caps = await capabilities()
    const tools = [
      { name: 'whoami', description: 'Пользователь продукта, от чьего имени работает ключ', method: 'GET', path: '/api/v1/me', input: {} },
      { name: 'list_modules', description: 'Список модулей и признак, у каких описание полное. Ключевые слова: модули, capabilities, modules', method: 'GET', path: '/api/v1/modules', input: {} },
      {
        name: 'describe_module',
        description: 'Полное описание модуля: все параметры, ограничения, блоки интерфейса, расшифровка пресетов, примеры запусков и JSON Schema входа. Ключевые слова: схема, параметры, ограничения, help, schema, params',
        method: 'GET',
        path: '/api/v1/modules/:key/describe',
        input: { key: `string — один из: ${listDescriptorKeys().join(', ')}` },
      },
      { name: 'create_goal', description: 'Создать цель (измеримый результат)', method: 'POST', path: '/api/v1/goals', input: { name: 'string', metric: 'string?', target: 'number?', deadline: 'YYYY-MM-DD?' } },
      { name: 'create_campaign', description: 'Создать кампанию под цель', method: 'POST', path: '/api/v1/campaigns', input: { name: 'string', modules: 'string[]', goalId: 'string?' } },
      { name: 'estimate', description: 'Оценить стоимость и время до запуска', method: 'POST', path: '/api/v1/modules/:key/estimate', input: { actions: 'number', accounts: 'number?' } },
      ...caps.map((c) => {
        const module = describeModule(c.key)
        return {
          name: `run_${c.key.replace(/-/g, '_')}`,
          description: module
            ? `${module.whoAmI.summary} Ключевые слова: ${module.tags.join(', ')}.`
            : `Запустить модуль «${c.title}» (схема не описана — список полей неполный)`,
          method: 'POST',
          path: c.run.path,
          schema: c.schema,
          // У описанных модулей — настоящая JSON Schema; у остальных прежние подсказки,
          // но с честной пометкой `schema: 'partial'`, чтобы их не принимали за полные.
          input: module ? module.inputSchema : c.run.body,
          ...(module ? { _meta: { tags: module.tags, version: module.version, describe: c.describe } } : {}),
        }
      }),
    ]
    res.json({
      ok: true,
      name: 'murmex',
      version: '1',
      // Совместимость: этим GET уже пользуются, ломать нельзя. Но настоящий вход —
      // POST на этот же адрес, и клиент должен о нём узнать.
      note: 'REST-срез для просмотра глазами. Полноценный MCP — JSON-RPC 2.0 на POST этого же адреса.',
      mcp: {
        endpoint: '/api/v1/mcp',
        transport: 'streamable-http (JSON-RPC 2.0 через POST)',
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        serverInfo: SERVER_INFO,
        auth: 'Authorization: Bearer <api-key>',
      },
      coverage: { described: listDescriptorKeys().length, total: caps.length },
      tools,
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

/** §10.3(1): цели. */
apiV1Router.get('/goals', async (_req, res) => {
  try { const { listGoals } = await import('./goals.js'); res.json({ ok: true, goals: await listGoals() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/goals', async (req, res) => {
  try { const { createGoal } = await import('./goals.js'); res.json({ ok: true, goal: await createGoal(req.body || {}) }) }
  catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

/** §10.3(1): кампании. */
apiV1Router.get('/campaigns', async (_req, res) => {
  try { const { listCampaigns } = await import('./campaigns.js'); res.json({ ok: true, campaigns: await listCampaigns() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/campaigns', async (req, res) => {
  try { const { createCampaign } = await import('./campaigns.js'); res.json({ ok: true, campaign: await createCampaign(req.body || {}) }) }
  catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
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
