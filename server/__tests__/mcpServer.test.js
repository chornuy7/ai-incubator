import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMessage, listResources, readResource, SUPPORTED_PROTOCOL_VERSIONS, SERVER_INFO } from '../mcp/server.js'
import { TOOLS } from '../mcp/tools.js'
import { listDescriptorKeys } from '../mcp/descriptors/index.js'
import { originAllowed, checkHttpPreconditions, wantsEventStream, mcpDeleteHandler } from '../mcp/server.js'

// Контекст HTTP-запроса: нужен create_task — он проверяет права на аккаунты через
// accessGuard, а тот читает заголовки методом `header()`, как у express. Без него
// вызов падает внутренней ошибкой протокола вместо понятного отказа инструмента.
const CTX = { req: { headers: {}, header: () => undefined } }

const rpc = (method, params, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, CTX)
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args })
  return r.result
}
/** Инструменты отдают данные структурой; текст — та же структура для человека. */
const dataOf = (res) => res.structuredContent

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
})

test('initialize: незнакомую версию протокола не принимаем молча, предлагаем свою', async () => {
  const r = await rpc('initialize', { protocolVersion: '1999-01-01' })
  assert.equal(r.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0])
})

test('уведомления не получают ответа, ping получает', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, CTX), null)
  const pong = await rpc('ping', {})
  assert.deepEqual(pong.result, {})
})

test('ошибки протокола: битый конверт, неизвестный метод, пакетный запрос', async () => {
  const bad = await handleMessage({ method: 'ping', id: 1 }, CTX)
  assert.equal(bad.error.code, -32600)

  const unknown = await rpc('несуществующий/метод', {})
  assert.equal(unknown.error.code, -32601)

  // Пакетные запросы убраны из протокола — отвечаем понятно, а не «внутренняя ошибка».
  const batch = await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], CTX)
  assert.equal(batch.error.code, -32600)
  assert.match(batch.error.message, /Batch requests are not supported|One JSON-RPC message is expected/i)
})

test('tools/list: tools are declared with input schemas', async () => {
  const r = await rpc('tools/list', {})
  const names = r.result.tools.map((t) => t.name)

  assert.deepEqual(names, [
    'list_modules', 'describe_module', 'describe_block', 'validate_task', 'estimate_task',
    // Наблюдение и остановка добавлены после первого живого прогона: «мозги» умели
    // запустить задачу и не умели узнать, чем она кончилась, — create_task возвращал
    // REST-путь, закрытый сессией.
    'get_task', 'stop_task', 'create_task',
  ])
  for (const t of r.result.tools) {
    assert.ok(t.title && t.description, `${t.name}: нет названия или описания`)
    assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema не объект`)
    // Search by keywords is required at the protocol level, so the description must include them.
    assert.match(t.description, /Key words:/i, `${t.name}: missing searchable keywords`)
  }
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
  assert.match(miss.content[0].text, /Available:/i, 'error should suggest existing blocks')
})

test('unknown module: reject with available modules instead of inventing a schema', async () => {
  const r = await call('describe_module', { module: 'нет-такого-модуля' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Unknown module/i)
  assert.match(r.content[0].text, /Available:/i, 'error must suggest what exists')
  assert.ok(!r.error, 'must not be a JSON-RPC transport error')
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
  assert.match(byPath.accountIds, /required field is not filled in/i)
  assert.match(byPath.probability, /maximum|greater than/i)
  assert.match(byPath.commentMode, /invalid value|not allowed/i)
  assert.match(byPath.postWindow, /maximum|greater than/i)
  assert.match(byPath['неизвестноеПоле'], /unknown field/i)
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
  assert.match(warns.semanticFilter, /given goalId|only works when given goalId/i)
  assert.match(warns.promptIndex, /overlapped by field promptText|priority/i)
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
  assert.match(d.errors.at(-1).message, /Минимум больше максимума/)
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
  assert.match(r.content[0].text, /Invalid arguments:/i)

  const noName = await rpc('tools/call', { arguments: {} })
  assert.equal(noName.error.code, -32602)
})

test('resources: модуль и help по каждому блоку доступны как ресурсы', async () => {
  const r = await rpc('resources/list', {})
  const uris = r.result.resources.map((x) => x.uri)

  assert.ok(uris.includes('murmex://module/neuro-commenting'))
  assert.ok(uris.includes('murmex://help/neuro-commenting/timings'))
  for (const res of r.result.resources) {
    assert.ok(res.title && res.description, `${res.uri}: ресурс без описания`)
    assert.equal(res.mimeType, 'application/json')
  }

  const read = await rpc('resources/read', { uri: 'murmex://help/neuro-commenting/filters' })
  const body = JSON.parse(read.result.contents[0].text)
  assert.equal(body.id, 'filters')
  assert.ok(body.params.some((p) => p.name === 'semanticThreshold'))

  const missing = await rpc('resources/read', { uri: 'murmex://module/нет-такого' })
  assert.equal(missing.error.code, -32602)
})

test('listResources/readResource согласованы: всё, что перечислено, читается', () => {
  for (const res of listResources()) {
    const body = readResource(res.uri)
    assert.ok(body, `${res.uri}: перечислен, но не читается`)
    assert.doesNotThrow(() => JSON.parse(body.text), `${res.uri}: не валидный JSON`)
  }
})

test('create_task is clearly a real action and requires validation before calling', () => {
  const tool = TOOLS.find((t) => t.name === 'create_task')
  assert.match(tool.description, /ACTION IS REAL/i)
  assert.match(tool.description, /validate_task/i)
  assert.equal(tool.annotations.openWorldHint, true)
})

// ── соответствие транспорту Streamable HTTP ─────────────────────────────────────
// Всё ниже добавлено после сверки с текстом спецификации 2025-06-18: каждый пункт —
// «сервер ОБЯЗАН», которое мы сначала не выполняли.

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
})

test('MCP-Protocol-Version: unknown version -> 400, missing header is allowed', () => {
  assert.equal(checkHttpPreconditions({ headers: {} }), null, 'missing header is allowed for backward compatibility')
  assert.equal(checkHttpPreconditions({ headers: { 'mcp-protocol-version': '2025-06-18' } }), null)

  const bad = checkHttpPreconditions({ headers: { 'mcp-protocol-version': '2030-01-01' } })
  assert.equal(bad.status, 400, 'spec requires exactly 400')
  assert.match(bad.body.error, /Available:/i)
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

test('DELETE (session close) — 405: no sessions are kept', () => {
  let status = 0
  let body = null
  mcpDeleteHandler({}, { status(s) { status = s; return this }, json(b) { body = b } })
  assert.equal(status, 405)
  assert.match(body.error, /Sessions are not used/i)
})

test('JSON-RPC ответ от клиента принимается молча (202), а не как битый конверт', async () => {
  // У нас нет запросов К клиенту, но по спецификации такой вход валиден и требует 202.
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 7, result: {} }, CTX), null)
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'x' } }, CTX), null)

  // А вот мусор без method и без result/error — по-прежнему ошибка конверта.
  const junk = await handleMessage({ jsonrpc: '2.0', id: 8 }, CTX)
  assert.equal(junk.error.code, -32600)
})

test('get_task and stop_task: clear failure when task does not exist', async () => {
  const missing = await call('get_task', { module: 'ggr', taskId: 'нет_такой' })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /not found/i)

  const badModule = await call('get_task', { module: 'нет-модуля', taskId: 'x' })
  assert.equal(badModule.isError, true)
  assert.match(badModule.content[0].text, /Unknown module/i)

  const stopMissing = await call('stop_task', { module: 'ggr', taskId: 'нет_такой' })
  assert.equal(stopMissing.isError, true)
  assert.match(stopMissing.content[0].text, /not found/i)
})

test('stop_task clearly warns that already-taken actions are not canceled', () => {
  const tool = TOOLS.find((t) => t.name === 'stop_task')
  assert.match(tool.description, /not canceled|not cancelled/i)
  assert.equal(tool.annotations.idempotentHint, true, 'repeat stop is safe')
})

test('create_task saves the task before starting it or it silently never runs', async () => {
  // Регресс живого прогона 14.08: startWorker поднимает задачу из хранилища по id.
  // Без записи он ничего не находит и тихо выходит — задача получала id, показывала
  // статус queued и никогда не выполнялась. Путь UI сохранял, оба API-пути — нет.
  const created = dataOf(await call('create_task', { module: 'ggr', settings: { accountIds: ['acc_test_1'] } }))
  assert.ok(created?.taskId, 'задача создана')

  const seen = dataOf(await call('get_task', { module: 'ggr', taskId: created.taskId }))
  assert.equal(seen.taskId, created.taskId, 'сразу после создания задача обязана читаться из хранилища')
  assert.equal(seen.initiator, 'mcp', 'происхождение помечено — правка руками потом запрещена')

  // Приберём за собой: тест не должен оставлять живую задачу в хранилище.
  await call('stop_task', { module: 'ggr', taskId: created.taskId })
})
