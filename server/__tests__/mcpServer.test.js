import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleMessage, listResources, readResource, RESOURCE_TEMPLATES, INSTRUCTIONS,
  originAllowed, checkHttpPreconditions, wantsEventStream, mcpDeleteHandler, detectEra,
} from '../mcp/server.js'
import {
  SUPPORTED_PROTOCOL_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS, SERVER_INFO, META, ERR,
  httpStatusForError,
} from '../mcp/protocol.js'
import { TOOLS } from '../mcp/tools.js'
import { PROMPTS } from '../mcp/prompts.js'
import { listDescriptorKeys } from '../mcp/descriptors/index.js'

// Контекст HTTP-запроса: нужен create_task — он проверяет права на аккаунты через
// accessGuard, а тот читает заголовки методом `header()`, как у express. Без него
// вызов падает внутренней ошибкой протокола вместо понятного отказа инструмента.
const CTX = { req: { headers: {}, header: () => undefined }, headers: {} }

/** `_meta` современного клиента: версия + возможности обязательны на КАЖДОМ запросе. */
const MODERN_META = {
  [META.PROTOCOL_VERSION]: MODERN_VERSIONS[0],
  [META.CLIENT_CAPABILITIES]: {},
  [META.CLIENT_INFO]: { name: 'test', version: '1' },
}

const rpc = (method, params, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, CTX)
const modern = (method, params = {}, id = 1, headers = {}) =>
  handleMessage({ jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } }, { ...CTX, headers })

const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result
/** Инструменты отдают данные структурой; текст — та же структура для человека. */
const dataOf = (res) => res.structuredContent

// ── Ревизия 2026-07-28: протокол без рукопожатия ────────────────────────────────

test('server/discover обязателен и отдаёт версии, возможности и инструкцию', async () => {
  const r = await modern('server/discover')

  assert.equal(r.result.resultType, 'complete', 'все результаты modern-эры несут resultType')
  assert.deepEqual(r.result.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS)
  assert.ok(r.result.capabilities.tools, 'сервер обязан объявить инструменты')
  assert.ok(r.result.capabilities.resources, 'и ресурсы — help по блокам отдаётся ими')
  assert.ok(r.result.capabilities.prompts, 'и промпты — они больше не пустые')
  assert.deepEqual(r.result._meta[META.SERVER_INFO], SERVER_INFO, 'личность сервера едет в _meta результата')
  // Кэширование: `CacheableResult` требует обоих полей, иначе клиент вынужден
  // перезапрашивать список на каждом шаге рассуждения.
  assert.ok(r.result.ttlMs > 0)
  assert.equal(r.result.cacheScope, 'private', 'состав зависит от ключа — общий кэш недопустим')
  assert.match(r.result.instructions, /validate_task/)
})

test('server/discover работает БЕЗ версии в _meta — иначе им нельзя узнать версии', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, CTX)
  assert.ok(r.result.supportedVersions.length)
})

test('modern-запрос без per-request _meta отклоняется с объяснением', async () => {
  const r = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { ...CTX, headers: { 'mcp-protocol-version': MODERN_VERSIONS[0] } },
  )
  assert.equal(r.error.code, ERR.INVALID_PARAMS)
  assert.match(r.error.message, /_meta/)
  assert.match(r.error.message, /server\/discover/, 'ошибка обязана подсказать выход')
})

test('незнакомая версия протокола — UnsupportedProtocolVersion со списком поддерживаемых', async () => {
  const r = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { [META.PROTOCOL_VERSION]: '1999-01-01', [META.CLIENT_CAPABILITIES]: {} } },
  }, CTX)

  assert.equal(r.error.code, -32022, 'код закреплён спецификацией')
  assert.deepEqual(r.error.data.supported, SUPPORTED_PROTOCOL_VERSIONS, 'клиент должен уметь повторить запрос')
  assert.equal(r.error.data.requested, '1999-01-01')
  assert.equal(httpStatusForError(r.error.code), 400, 'по статусу клиент отличает modern-сервер от legacy')
})

test('заголовки Mcp-* обязаны совпадать с телом — иначе HeaderMismatch', async () => {
  // Балансировщик маршрутизирует по заголовку, сервер исполняет тело. Разъехались —
  // и запрос посчитали не там, где выполнили.
  const wrongName = await modern('tools/call', { name: 'list_modules', arguments: {} }, 1,
    { 'mcp-protocol-version': MODERN_VERSIONS[0], 'mcp-method': 'tools/call', 'mcp-name': 'create_task' })
  assert.equal(wrongName.error.code, -32020)

  const wrongMethod = await modern('tools/list', {}, 1,
    { 'mcp-protocol-version': MODERN_VERSIONS[0], 'mcp-method': 'resources/list' })
  assert.equal(wrongMethod.error.code, -32020)

  const versionClash = await modern('tools/list', {}, 1, { 'mcp-protocol-version': '2025-06-18' })
  assert.equal(versionClash.error.code, -32020, 'версия в заголовке и в теле обязана совпадать')

  const good = await modern('tools/list', {}, 1,
    { 'mcp-protocol-version': MODERN_VERSIONS[0], 'mcp-method': 'tools/list' })
  assert.ok(good.result.tools.length)
})

test('MCP_STRICT_HEADERS=1 требует Mcp-* по букве спецификации', async () => {
  // По умолчанию проверяем согласованность, а не наличие: ревизия свежая, SDK ещё не
  // шлют эти заголовки, и безусловный отказ выключил бы живых клиентов. Флаг включает
  // полную строгость — когда экосистема догонит, он станет умолчанием.
  const lenient = await modern('tools/list', {}, 1, { 'mcp-protocol-version': MODERN_VERSIONS[0] })
  assert.ok(lenient.result.tools.length, 'без флага отсутствие Mcp-Method не мешает')

  process.env.MCP_STRICT_HEADERS = '1'
  try {
    const strict = await modern('tools/list', {}, 1, { 'mcp-protocol-version': MODERN_VERSIONS[0] })
    assert.equal(strict.error.code, -32020)
    assert.match(strict.error.message, /Mcp-Method is missing/)

    const named = await modern('tools/call', { name: 'list_modules', arguments: {} }, 1,
      { 'mcp-protocol-version': MODERN_VERSIONS[0], 'mcp-method': 'tools/call' })
    assert.match(named.error.message, /Mcp-Name is missing/)

    // Вызовов не по HTTP (заголовков нет вовсе) строгий режим не касается.
    const offHttp = await modern('tools/list', {}, 1, {})
    assert.ok(offHttp.result.tools.length)
  } finally {
    delete process.env.MCP_STRICT_HEADERS
  }
})

test('ping удалён в 2026-07-28, но продолжает отвечать legacy-клиентам', async () => {
  assert.equal((await modern('ping')).error.code, ERR.METHOD_NOT_FOUND)
  assert.deepEqual((await rpc('ping', {})).result, {}, 'старый клиент не должен сломаться')
})

test('detectEra: заголовок сильнее тела — сломанный modern не обслуживается как legacy', () => {
  assert.equal(detectEra({ method: 'tools/list', params: {} }, {}).modern, false)
  assert.equal(detectEra({ method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2026-07-28' }).modern, true)
  assert.equal(detectEra({ method: 'tools/list', params: { _meta: MODERN_META } }, {}).modern, true)
  assert.equal(detectEra({ method: 'server/discover' }, {}).modern, true)
})

// ── Legacy-эра: рукопожатие продолжает работать ────────────────────────────────

test('initialize: отвечает версией протокола, возможностями и инструкцией', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

  assert.equal(r.jsonrpc, '2.0')
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.deepEqual(r.result.serverInfo, SERVER_INFO)
  assert.ok(r.result.capabilities.tools, 'сервер обязан объявить инструменты')
  assert.ok(r.result.capabilities.resources, 'и ресурсы — help по блокам отдаётся ими')
  // Инструкция — то, что модель прочитает до первого вызова. Без порядка работы
  // «мозги» идут сразу в create_task и тратят деньги на невалидной задаче.
  assert.match(r.result.instructions, /validate_task/)
  assert.equal('resultType' in r.result, false, 'legacy-клиент этого поля не знает')
})

test('initialize: незнакомую версию не принимаем молча, предлагаем свежайшую legacy', async () => {
  const r = await rpc('initialize', { protocolVersion: '1999-01-01' })
  assert.equal(r.result.protocolVersion, LEGACY_VERSIONS[0])
  // Предложить 2026-07-28 нельзя: у неё нет рукопожатия, и клиент, который его
  // только что сделал, по ней работать не умеет.
  assert.equal(MODERN_VERSIONS.includes(r.result.protocolVersion), false)
})

test('initialize от modern-клиента отвергается с указанием, куда идти', async () => {
  const r = await modern('initialize', { protocolVersion: MODERN_VERSIONS[0] })
  assert.equal(r.error.code, ERR.METHOD_NOT_FOUND)
  assert.match(r.error.message, /server\/discover/)
})

test('уведомления не получают ответа', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, CTX), null)
})

test('ошибки протокола: битый конверт, неизвестный метод, пакетный запрос', async () => {
  const bad = await handleMessage({ method: 'ping', id: 1 }, CTX)
  assert.equal(bad.error.code, ERR.INVALID_REQUEST)

  const unknown = await rpc('несуществующий/метод', {})
  assert.equal(unknown.error.code, ERR.METHOD_NOT_FOUND)
  assert.equal(httpStatusForError(unknown.error.code), 404, 'спецификация требует именно 404')

  // Пакетные запросы убраны из протокола — отвечаем понятно, а не «внутренняя ошибка».
  const batch = await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], CTX)
  assert.equal(batch.error.code, ERR.INVALID_REQUEST)
  assert.match(batch.error.message, /Batch requests are not supported/i)
})

test('JSON-RPC ответ от клиента принимается молча (202), а не как битый конверт', async () => {
  // У нас нет запросов К клиенту, но по спецификации такой вход валиден и требует 202.
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 7, result: {} }, CTX), null)
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'x' } }, CTX), null)

  // А вот мусор без method и без result/error — по-прежнему ошибка конверта.
  const junk = await handleMessage({ jsonrpc: '2.0', id: 8 }, CTX)
  assert.equal(junk.error.code, ERR.INVALID_REQUEST)
})

// ── Инструменты ────────────────────────────────────────────────────────────────

test('tools/list: у каждого инструмента есть схема входа, схема ВЫХОДА и аннотации', async () => {
  const r = await rpc('tools/list', {})
  const names = r.result.tools.map((t) => t.name)

  assert.deepEqual(names, [
    // Возможности идут первыми: «что мне вообще можно» — вопрос до «что умеет модуль».
    'list_capabilities', 'describe_capability',
    'list_modules', 'describe_module', 'describe_block', 'validate_task', 'estimate_task',
    // Наблюдение и остановка добавлены после первого живого прогона: «мозги» умели
    // запустить задачу и не умели узнать, чем она кончилась, — create_task возвращал
    // REST-путь, закрытый сессией.
    'get_task', 'stop_task', 'create_task',
  ])
  for (const t of r.result.tools) {
    assert.ok(t.title && t.description, `${t.name}: нет названия или описания`)
    assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema не объект`)
    // Без outputSchema `structuredContent` — это JSON, про который клиент не знает
    // ничего: ни полей, ни типов. Схема выхода — половина контракта.
    assert.ok(t.outputSchema, `${t.name}: нет outputSchema`)
    assert.equal(t.outputSchema.type, 'object', `${t.name}: outputSchema не объект`)
    assert.ok(t.annotations, `${t.name}: нет аннотаций поведения`)
    // Search by keywords is required at the protocol level, so the description must include them.
    assert.match(t.description, /Keywords:/i, `${t.name}: missing searchable keywords`)
  }
})

test('аннотации не врут: читающие инструменты readOnly, запуск помечен разрушающим', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]))

  for (const name of ['list_modules', 'describe_module', 'describe_block', 'validate_task', 'estimate_task', 'get_task']) {
    assert.equal(byName[name].readOnlyHint, true, `${name}: ничего не меняет, обязан быть readOnly`)
    assert.equal(byName[name].idempotentHint, true, `${name}: повтор безопасен`)
  }

  // Главная правка набора. `destructiveHint: false` означает для клиента «изменения
  // только аддитивные, можно вызывать без подтверждения» — про вызов, который
  // публикует в Telegram и списывает деньги, это прямая ложь.
  assert.equal(byName.create_task.readOnlyHint, false)
  assert.equal(byName.create_task.destructiveHint, true, 'необратимое действие с деньгами и живыми аккаунтами')
  assert.equal(byName.create_task.idempotentHint, false, 'повторный вызов создаст ВТОРУЮ задачу')
  assert.equal(byName.create_task.openWorldHint, true)

  assert.equal(byName.stop_task.idempotentHint, true, 'повторная остановка безопасна')
  assert.equal(byName.stop_task.readOnlyHint, false)
})

test('outputSchema описывает то, что инструмент реально возвращает', async () => {
  const schemaOf = (n) => TOOLS.find((t) => t.name === n).outputSchema
  const covers = (schema, data) => {
    for (const key of schema.required || []) {
      assert.ok(key in data, `в ответе нет обязательного по схеме поля ${key}`)
    }
    for (const key of Object.keys(data)) {
      assert.ok(schema.properties[key], `поле ${key} возвращается, но не описано в outputSchema`)
    }
  }
  covers(schemaOf('list_modules'), dataOf(await call('list_modules', {})))
  covers(schemaOf('describe_module'), dataOf(await call('describe_module', { module: 'neuro-commenting' })))
  covers(schemaOf('validate_task'), dataOf(await call('validate_task', { module: 'ggr', settings: { accountIds: ['a'] } })))
  covers(schemaOf('estimate_task'), dataOf(await call('estimate_task', { module: 'ggr', actions: 10 })))
})

test('list_modules: честно разделяет описанные модули и остальные', async () => {
  const d = dataOf(await call('list_modules', {}))

  assert.ok(d.total >= 15, 'перечислены все модули платформы')
  // Сверяем с реестром, а не с константой: иначе тест краснеет на каждом новом
  // дескрипторе и его начинают править не глядя.
  assert.equal(d.described, listDescriptorKeys().length)
  // Покрытие полное с 14.08. Если модуль появится без дескриптора — тест это поймает,
  // и «мозги» узнают об этом раньше, чем соберут задачу по неполному описанию.
  assert.equal(d.described, d.total, 'у каждого модуля платформы должен быть дескриптор')
  assert.equal(d.modules.every((m) => m.described), true)

  const nc = d.modules.find((m) => m.key === 'neuro-commenting')
  assert.ok(nc.paramCount >= 25, 'у описанного модуля видно число параметров')
  assert.match(d.note, /described = true/)
})

test('describe_module: отдаёт всё, что просил заказчик, одним вызовом', async () => {
  const d = dataOf(await call('describe_module', { module: 'neuro-commenting' }))

  assert.ok(d.whoAmI.doesNot.length, 'чего модуль НЕ делает — без этого выбирают не тот модуль')
  assert.ok(d.blocks.length >= 8)
  assert.ok(d.params.length >= 25, 'все параметры, а не 5 как в старом манифесте')
  assert.ok(d.presets.length >= 2, 'расшифровка пресетов')
  assert.ok(d.examples.length >= 2)
  assert.ok(d.inputSchema.properties.probability.maximum === 100, 'ограничения машинные, а не текстом')
})

test('describe_block: справка по блоку с указанием API и полей', async () => {
  const d = dataOf(await call('describe_block', { module: 'neuro-commenting', block: 'timings' }))

  assert.equal(d.module, 'neuro-commenting')
  assert.ok(d.howItWorks, 'как работает блок')
  assert.ok(d.api.path, 'какой API вызывает')
  assert.ok(d.api.fills.includes('delayPreset'), 'какие поля API заполняет')
  assert.ok(d.params.every((p) => p.purpose), 'у каждого параметра блока есть назначение')

  const miss = await call('describe_block', { module: 'neuro-commenting', block: 'нетТакого' })
  assert.equal(miss.isError, true)
  assert.match(miss.content[0].text, /Available blocks:/i, 'error should suggest existing blocks')
})

test('unknown module: reject with available modules instead of inventing a schema', async () => {
  const r = await call('describe_module', { module: 'нет-такого-модуля' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not allowed|Unknown module/i)
  assert.ok(!r.error, 'must not be a JSON-RPC transport error')
})

test('неизвестный инструмент — ошибка ПРОТОКОЛА, а не результат вызова', async () => {
  // Спецификация разделяет: то, что модель может починить (аргументы), приходит
  // как isError; то, чего не может (нет такого инструмента), — как ошибка JSON-RPC.
  const r = await rpc('tools/call', { name: 'нет_такого', arguments: {} })
  assert.equal(r.error.code, ERR.INVALID_PARAMS)
  assert.match(r.error.message, /Available tools:/i)
})

test('validate_task: detects schema violations with the field path', async () => {
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: {
      accountIds: [], // обязательное пустое
      channels: ['@durov'],
      probability: 150, // выше максимума
      commentMode: 9, // нет такого значения
      postWindow: 500, // выше максимума
      неизвестноеПоле: 1,
    },
  }))

  assert.equal(d.valid, false)
  const byPath = Object.fromEntries(d.errors.map((e) => [e.path, e.message]))
  assert.match(byPath.accountIds, /Required field is missing/i)
  assert.match(byPath.probability, /above the maximum of 100/i)
  assert.match(byPath.commentMode, /not allowed.*0, 1, 2/i)
  assert.match(byPath.postWindow, /above the maximum/i)
  assert.match(byPath['неизвестноеПоле'], /Unknown field/i)

  // Каждая ошибка несёт машинный код — по нему оркестратор ветвится, не разбирая текст.
  assert.ok(d.errors.every((e) => typeof e.code === 'string' && e.code))
})

test('validate_task: опечатка в имени поля получает подсказку, а не только отказ', async () => {
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: { accountIds: ['acc_1'], channels: ['@durov'], probabilty: 50 },
  }))
  const typo = d.errors.find((e) => e.path === 'probabilty')
  assert.match(typo.message, /Did you mean "probability"/i, 'близкое имя надо предложить, а не заставлять искать')
})

test('validate_task: warns about fields that are set but won\'t work', async () => {
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: {
      accountIds: ['acc_1'],
      channels: ['@durov'],
      commentMode: 0, // не «по ключевым словам»…
      keywords: ['крипта'], // …а ключевые слова заданы
      semanticFilter: true, // без цели не заработает
      promptText: 'свой промпт',
      promptIndex: 3, // перекрывается promptText
    },
  }))

  assert.equal(d.valid, true, 'schema is valid; these are warnings, not errors')
  const warns = Object.fromEntries(d.warnings.map((w) => [w.path, w.message]))
  assert.match(warns.keywords, /commentMode = 1/i)
  assert.match(warns.semanticFilter, /goalId is set/i)
  assert.match(warns.promptIndex, /Overridden by "promptText"/i)
})

test('условия применимости попадают и в САМУ схему, а не только в предупреждения', async () => {
  const d = dataOf(await call('describe_module', { module: 'neuro-commenting' }))
  // Иначе модель узнаёт об условии уже после того, как собрала задачу и получила warning.
  assert.match(d.inputSchema.properties.keywords.description, /Only takes effect when commentMode = 1/i)
  assert.match(d.inputSchema.properties.probability.description, /Constraints: /)
})

test('validate_task: требует durationMinutes при работе по времени', async () => {
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: { accountIds: ['acc_1'], channels: ['@durov'], workMode: 1 },
  }))
  assert.equal(d.valid, false)
  assert.match(d.errors.find((e) => e.path === 'durationMinutes').message, /workMode = 1/)
})

test('validate_task: прогоняет и настоящую проверку запуска, а не только схему', async () => {
  // min > max схемой не ловится — это правило живёт в валидации запуска. Если бы
  // validate_task её не звал, «мозги» получили бы «всё в порядке» на задаче,
  // которую сервер откажется запускать.
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: { accountIds: ['acc_1'], channels: ['@durov'], minComments: 50, maxComments: 10 },
  }))
  assert.equal(d.valid, false)
  // Код КОНКРЕТНЫЙ, а не общий «launchRule»: по нему оркестратор ветвится, не разбирая
  // текст. `launchRule` остаётся запасным именем для правил, у которых своего кода нет.
  assert.equal(d.errors.at(-1).code, 'minGreaterThanMax')
  // Сообщение приходит по-английски (правило «ЯЗЫК MCP» в CLAUDE.md): русская форма
  // остаётся панели, в протокол уезжает `messageEn` из `validateSettingsDetailed`.
  assert.match(d.errors.at(-1).message, /Minimum is greater than maximum: comments/)
  assert.equal(/[а-яё]/i.test(d.errors.at(-1).message), false, 'кириллице в ответе протокола не место')
})

test('validate_task: валидный черновик признаётся валидным', async () => {
  const d = dataOf(await call('validate_task', {
    module: 'neuro-commenting',
    settings: {
      accountIds: ['acc_1'],
      channels: ['@durov'],
      commentMode: 1,
      keywords: ['ai'],
      maxComments: 10,
      maxPerAccount: 5,
      protectionLevel: 0,
      delayPreset: 2,
      delays: { comment: [60, 180], join: [90, 200], floodWait: 150, floodQuarantine: 3 },
    },
  }))
  assert.equal(d.valid, true, JSON.stringify(d.errors))
  assert.deepEqual(d.warnings, [])
})

test('tools/call: invalid tool arguments are a tool error, not a protocol failure', async () => {
  const r = await call('describe_module', { модуль: 'neuro-commenting' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Invalid arguments/i)

  const noName = await rpc('tools/call', { arguments: {} })
  assert.equal(noName.error.code, ERR.INVALID_PARAMS)
})

// ── Ресурсы и промпты ──────────────────────────────────────────────────────────

test('resources: модуль и help по каждому блоку доступны как ресурсы', async () => {
  const r = await rpc('resources/list', {})
  assert.ok(r.result.nextCursor, '107 ресурсов не должны приезжать одной страницей')
  assert.ok(r.result.ttlMs > 0 && r.result.cacheScope)

  // Собираем ВСЕ страницы: пагинация не должна прятать часть каталога.
  const all = []
  let cursor
  do {
    const page = await rpc('resources/list', cursor ? { cursor } : {})
    all.push(...page.result.resources)
    cursor = page.result.nextCursor
  } while (cursor)

  const uris = all.map((x) => x.uri)
  assert.equal(new Set(uris).size, uris.length, 'страницы не должны перекрываться')
  assert.equal(uris.length, listResources().length, 'пагинация обязана отдать весь список')
  assert.ok(uris.includes('murmex://module/neuro-commenting'))
  assert.ok(uris.includes('murmex://help/neuro-commenting/timings'))
  for (const res of all) {
    assert.ok(res.title && res.description, `${res.uri}: ресурс без описания`)
    assert.equal(res.mimeType, 'application/json')
  }

  const read = await rpc('resources/read', { uri: 'murmex://help/neuro-commenting/filters' })
  const body = JSON.parse(read.result.contents[0].text)
  assert.equal(body.id, 'filters')
  assert.ok(body.params.some((p) => p.name === 'semanticThreshold'))

  const missing = await rpc('resources/read', { uri: 'murmex://module/нет-такого' })
  // Ревизия 2026-07-28 запретила −32002 и велела отвечать −32602.
  assert.equal(missing.error.code, ERR.INVALID_PARAMS)
  assert.match(missing.error.message, /murmex:\/\/module\/<moduleKey>/, 'ошибка обязана показать верную форму URI')
})

test('битый курсор — понятная ошибка, а не молчаливая первая страница', async () => {
  const r = await rpc('resources/list', { cursor: 'не-курсор' })
  assert.equal(r.error.code, ERR.INVALID_PARAMS)
})

test('resources/templates/list: клиент может собрать URI сам, не листая каталог', async () => {
  const r = await rpc('resources/templates/list', {})
  const templates = r.result.resourceTemplates.map((t) => t.uriTemplate)
  assert.deepEqual(templates, RESOURCE_TEMPLATES.map((t) => t.uriTemplate))
  assert.ok(templates.includes('murmex://module/{moduleKey}'))
  for (const t of r.result.resourceTemplates) assert.ok(t.name && t.description && t.mimeType)
})

test('listResources/readResource согласованы: всё, что перечислено, читается', () => {
  for (const res of listResources()) {
    const body = readResource(res.uri)
    assert.ok(body, `${res.uri}: перечислен, но не читается`)
    assert.doesNotThrow(() => JSON.parse(body.text), `${res.uri}: не валидный JSON`)
  }
})

test('промпты объявлены и реально отдаются', async () => {
  // Раньше возможность `prompts` объявлялась, а список приходил пустой: клиент видел
  // обещание и не получал ничего.
  const list = await rpc('prompts/list', {})
  assert.ok(list.result.prompts.length >= 4)
  assert.deepEqual(list.result.prompts.map((p) => p.name), PROMPTS.map((p) => p.name))
  for (const p of list.result.prompts) {
    assert.ok(p.title && p.description, `${p.name}: промпт без описания`)
    assert.ok(Array.isArray(p.arguments), `${p.name}: не объявлены аргументы`)
  }

  const got = await rpc('prompts/get', { name: 'plan_campaign', arguments: { goal: 'найти 50 лидов' } })
  assert.ok(got.result.messages.length)
  assert.match(got.result.messages[0].content.text, /найти 50 лидов/, 'аргумент обязан подставиться')
  assert.match(got.result.messages[0].content.text, /validate_task/, 'промпт обязан вести правильным порядком')

  const bad = await rpc('prompts/get', { name: 'нет-такого' })
  assert.equal(bad.error.code, ERR.INVALID_PARAMS)
})

test('инструкция сервера задаёт порядок работы и предупреждает о необратимости', () => {
  assert.match(INSTRUCTIONS, /list_modules/)
  assert.match(INSTRUCTIONS, /validate_task/)
  assert.match(INSTRUCTIONS, /never rolled back|REAL/i)
})

// ── соответствие транспорту Streamable HTTP ─────────────────────────────────────

test('Origin проверяется — защита от DNS rebinding', () => {
  // Без Origin (curl, сервер-к-серверу, MCP-клиент вне браузера) — пропускаем:
  // атака возможна только из браузера, а он Origin ставит всегда.
  assert.equal(originAllowed(undefined), true)
  assert.equal(originAllowed('https://myrmexgram.ai'), true)
  assert.equal(originAllowed('http://localhost:5173'), true)

  assert.equal(originAllowed('https://evil.example.com'), false)
  assert.equal(originAllowed('не-урл'), false)

  const blocked = checkHttpPreconditions({ headers: { origin: 'https://evil.example.com' } })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.jsonrpc, '2.0', 'тело — JSON-RPC ошибка, клиент разбирает один формат')
})

test('Origin: список расширяется через окружение, а не правкой исходника', () => {
  const prev = process.env.MCP_ALLOWED_ORIGINS
  process.env.MCP_ALLOWED_ORIGINS = 'stage.example.com'
  try {
    assert.equal(originAllowed('https://stage.example.com'), true)
    assert.equal(originAllowed('https://other.example.com'), false)
  } finally {
    if (prev === undefined) delete process.env.MCP_ALLOWED_ORIGINS
    else process.env.MCP_ALLOWED_ORIGINS = prev
  }
})

test('MCP-Protocol-Version: unknown version -> 400, missing header is allowed', () => {
  assert.equal(checkHttpPreconditions({ headers: {} }), null, 'missing header is allowed for backward compatibility')
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(checkHttpPreconditions({ headers: { 'mcp-protocol-version': v } }), null, `${v} обязана приниматься`)
  }

  const bad = checkHttpPreconditions({ headers: { 'mcp-protocol-version': '2030-01-01' } })
  assert.equal(bad.status, 400, 'spec requires exactly 400')
  assert.equal(bad.body.error.code, -32022)
  assert.deepEqual(bad.body.error.data.supported, SUPPORTED_PROTOCOL_VERSIONS)
})

test('GET with Accept: text/event-stream is recognized as an attempt to open a stream', () => {
  // Поток мы не держим, поэтому такой GET обязан получить 405 — иначе клиент примет
  // наш REST-манифест за открытый SSE-поток и будет ждать сообщений, которых нет.
  assert.equal(wantsEventStream({ headers: { accept: 'text/event-stream' } }), true)
  assert.equal(wantsEventStream({ headers: { accept: 'application/json, text/event-stream' } }), true)
  // А обычный GET по тому же адресу — это человек смотрит манифест, ему 405 не нужен.
  assert.equal(wantsEventStream({ headers: { accept: 'application/json' } }), false)
  assert.equal(wantsEventStream({ headers: {} }), false)
})

test('DELETE (session close) — 405: сессий в протоколе больше нет', () => {
  let status = 0
  let body = null
  mcpDeleteHandler({}, { status(s) { status = s; return this }, json(b) { body = b } })
  assert.equal(status, 405)
  assert.match(body.error.message, /sessions were removed/i)
})

// ── Живые операции ─────────────────────────────────────────────────────────────

test('get_task and stop_task: clear failure when task does not exist', async () => {
  const missing = await call('get_task', { module: 'ggr', taskId: 'нет_такой' })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /not found/i)

  const badModule = await call('get_task', { module: 'нет-модуля', taskId: 'x' })
  assert.equal(badModule.isError, true)
  assert.match(badModule.content[0].text, /not allowed|Unknown module/i)

  const stopMissing = await call('stop_task', { module: 'ggr', taskId: 'нет_такой' })
  assert.equal(stopMissing.isError, true)
  assert.match(stopMissing.content[0].text, /not found/i)
})

test('create_task is clearly a real action and requires validation before calling', () => {
  const tool = TOOLS.find((t) => t.name === 'create_task')
  assert.match(tool.description, /REAL, IRREVERSIBLE/i)
  assert.match(tool.description, /validate_task/i)
  assert.equal(tool.annotations.openWorldHint, true)
})

test('stop_task clearly warns that already-taken actions are not canceled', () => {
  const tool = TOOLS.find((t) => t.name === 'stop_task')
  assert.match(tool.description, /NOT undone|not canceled|not cancelled/i)
  assert.equal(tool.annotations.idempotentHint, true, 'repeat stop is safe')
})

test('create_task saves the task before starting it or it silently never runs', async () => {
  // Регресс живого прогона 14.08: startWorker поднимает задачу из хранилища по id.
  // Без записи он ничего не находит и тихо выходит — задача получала id, показывала
  // статус queued и никогда не выполнялась. Путь UI сохранял, оба API-пути — нет.
  const created = dataOf(await call('create_task', { module: 'ggr', settings: { accountIds: ['acc_test_1'] } }))
  assert.ok(created?.taskId, 'задача создана')
  // Раньше здесь стоял REST-путь, закрытый пользовательской сессией: по MCP-ключу он
  // не открывается, и «мозги» упирались в 401 ровно там, где им сказали смотреть.
  assert.match(created.note, /get_task/, 'дальнейший шаг обязан быть вызовом протокола, а не закрытым URL')

  const seen = dataOf(await call('get_task', { module: 'ggr', taskId: created.taskId }))
  assert.equal(seen.taskId, created.taskId, 'сразу после создания задача обязана читаться из хранилища')
  assert.equal(seen.initiator, 'mcp', 'происхождение помечено — правка руками потом запрещена')

  // Приберём за собой: тест не должен оставлять живую задачу в хранилище.
  await call('stop_task', { module: 'ggr', taskId: created.taskId })
})

test('отказ запуска приходит как ошибка инструмента, а не сбой протокола', async () => {
  // Живой прогон 18.08: «Аккаунты заняты другой задачей» прилетело кодом -32603
  // «внутренняя ошибка». Для оркестратора это тупик — по сбою сервера он может только
  // сдаться, тогда как занятый аккаунт лечится выбором другого профиля.
  const r = await call('create_task', { module: 'neuro-commenting', settings: { accountIds: ['acc_x'] } })
  assert.equal(r.isError, true, 'это результат вызова, который модель читает и исправляет')
  assert.ok(!r.error, 'транспортной ошибки JSON-RPC быть не должно')
  assert.match(r.content[0].text, /\S/, 'причина отказа обязана быть текстом')
})
