/**
 * MCP-сервер Murmex: JSON-RPC 2.0 поверх Streamable HTTP, две эры протокола сразу.
 *
 * До этого по адресу `/api/v1/mcp` лежал REST-манифест, который MCP только назывался:
 * ни одного метода протокола, ни одной схемы. Подключиться к нему штатным MCP-клиентом
 * было нельзя — заказчик назвал это «разными планетами», и был прав.
 *
 * ЭРЫ. Ревизия 2026-07-28 убрала рукопожатие: сессий нет, `initialize` нет, каждый
 * запрос сам несёт версию и возможности в `params._meta`, а `server/discover` обязателен.
 * Ревизии 2025-11-25 и раньше — наоборот, требуют `initialize`. Мы обслуживаем обе на
 * одном эндпоинте (spec 2026-07-28 § Backward Compatibility прямо это разрешает):
 * ломать уже подключённых legacy-клиентов нельзя, а новым нужен современный протокол.
 *
 * Транспорт: POST принимает одно JSON-RPC сообщение и отвечает одним JSON-ответом
 * (`application/json`). SSE-поток мы не открываем: серверных уведомлений у нас нет,
 * а спецификация разрешает отвечать телом, если сервер не инициирует поток сам.
 *
 * Ресурсы отдаются как `murmex://module/<key>` и `murmex://help/<key>/<block>`.
 */
import { TOOLS, ToolError, callTool } from './tools.js'
import { PROMPTS, getPrompt } from './prompts.js'
import { describeModule, listDescriptorKeys, getDescriptor } from './descriptors/index.js'
import {
  MODERN_VERSIONS, SUPPORTED_PROTOCOL_VERSIONS, LEGACY_VERSIONS, ASSUMED_LEGACY_VERSION,
  isModernVersion, isSupportedVersion, META, ERR, SERVER_INFO, CACHE,
  serverCapabilities, makeResult, makeError, unsupportedVersionError, httpStatusForError,
  requestMeta, paginate, cacheFields,
} from './protocol.js'

export { SUPPORTED_PROTOCOL_VERSIONS, SERVER_INFO, MODERN_VERSIONS, LEGACY_VERSIONS, ERR }

/**
 * Инструкция для модели — первое, что она читает о сервере. Отдаётся и в `initialize`,
 * и в `server/discover`.
 *
 * Пишется как порядок действий, а не как реклама: без него «мозги» идут сразу в
 * create_task и тратят деньги на невалидной задаче.
 */
export const INSTRUCTIONS = [
  'Murmex runs bulk operations on managed Telegram accounts: AI comments, DMs, dialogs, reactions, views, posting, channel/audience parsing, account warm-up and diagnostics.',
  '',
  'Always work in this order:',
  '0. list_capabilities — what this key may actually touch: modules, platform services (proxies, account manager, tasks dashboard, statistics, goals, campaigns, CRM, channels, logs, automation, billing) and its own permissions. Skip only if you already know.',
  '1. list_modules — see which modules exist and which have a complete schema.',
  '2. describe_module — the full contract of one module: every parameter, its limits, what the module does and explicitly does NOT do, presets and ready-made examples. Never guess field names; they differ per module.',
  '3. validate_task — check a draft against the schema AND the real launch rules. Free, touches nothing.',
  '4. estimate_task — money and time the run will cost.',
  '5. create_task — REAL: it publishes to Telegram and spends the balance. Only call it after validate_task returns valid: true.',
  '6. get_task to follow progress, stop_task to interrupt.',
  '',
  'Rules that save you a wasted run:',
  '• A module is only trustworthy when described = true. For the rest the field list is incomplete.',
  '• warnings from validate_task are not cosmetic: they mark fields you set that will be silently ignored.',
  '• Accounts are exclusive — one account runs one task at a time. "Account busy" means pick another, not retry.',
  '• Actions already performed in Telegram are never rolled back, including by stop_task.',
  '• A 403 is a permission fact, not a transient failure. Check list_capabilities and pick a different path instead of retrying.',
].join('\n')

// ── Ресурсы ────────────────────────────────────────────────────────────────────

/** Шаблоны URI — чтобы клиент мог собрать адрес сам, не листая 100+ ресурсов. */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'murmex://module/{moduleKey}',
    name: 'module-description',
    title: 'Full module description',
    description: 'Everything about one module: purpose, blocks, every parameter with limits, presets, examples and the JSON Schema of its task input. Same payload as the describe_module tool.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'murmex://help/{moduleKey}/{blockId}',
    name: 'block-help',
    title: 'Help for one interface block',
    description: 'What a single block of a module does, how it works, which parameters it owns and which API fields it fills.',
    mimeType: 'application/json',
  },
]

/** Ресурсы: полное описание модуля и help по каждому его блоку. */
export function listResources() {
  const out = []
  for (const key of listDescriptorKeys()) {
    const desc = getDescriptor(key)
    out.push({
      uri: `murmex://module/${key}`,
      name: `module-${key}`,
      title: `${desc.title} — full description`,
      description: desc.whoAmI.summary,
      mimeType: 'application/json',
    })
    for (const b of desc.blocks) {
      out.push({
        uri: `murmex://help/${key}/${b.id}`,
        name: `help-${key}-${b.id}`,
        title: `${desc.title}: ${b.title}`,
        description: b.purpose,
        mimeType: 'application/json',
      })
    }
  }
  return out
}

export function readResource(uri) {
  const module = /^murmex:\/\/module\/([\w-]+)$/.exec(uri)
  if (module) {
    const data = describeModule(module[1])
    if (!data) return null
    return { uri, name: `module-${module[1]}`, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }
  }
  const help = /^murmex:\/\/help\/([\w-]+)\/([\w-]+)$/.exec(uri)
  if (help) {
    const data = describeModule(help[1])
    const block = data?.blocks.find((b) => b.id === help[2])
    if (!block) return null
    return {
      uri,
      name: `help-${help[1]}-${help[2]}`,
      mimeType: 'application/json',
      text: JSON.stringify({ module: help[1], ...block }, null, 2),
    }
  }
  return null
}

// ── Разбор конверта и определение эры ──────────────────────────────────────────

/**
 * Какой эре принадлежит запрос.
 *
 * Заголовок сильнее тела: если транспорт объявил современную версию, а `_meta` пустой,
 * это НЕ legacy-клиент, а сломанный modern — и он должен получить внятную ошибку,
 * а не молча обслуживаться по старым правилам.
 *
 * @returns {{modern: boolean, version: string|null, headerVersion: string|null}}
 */
export function detectEra(message, headers = {}) {
  const headerVersion = headers['mcp-protocol-version'] ? String(headers['mcp-protocol-version']) : null
  const metaVersion = requestMeta(message?.params)[META.PROTOCOL_VERSION]
  const version = metaVersion ? String(metaVersion) : headerVersion
  const modern = isModernVersion(headerVersion) || isModernVersion(metaVersion) || message?.method === 'server/discover'
  return { modern, version: version || null, headerVersion }
}

/**
 * Проверки, обязательные для modern-запроса: версия, per-request `_meta`, совпадение
 * заголовков с телом.
 *
 * Заголовки сверяем не для красоты: балансировщик маршрутизирует по `Mcp-Method`, а
 * сервер исполняет то, что в теле. Разъехались — и запрос ушёл не туда, где его считали.
 *
 * @returns {object|null} JSON-RPC ошибка или null
 */
export function checkModernEnvelope(message, headers = {}) {
  const { id, method, params } = message
  const meta = requestMeta(params)
  const headerVersion = headers['mcp-protocol-version'] ? String(headers['mcp-protocol-version']) : null
  const metaVersion = meta[META.PROTOCOL_VERSION] ? String(meta[META.PROTOCOL_VERSION]) : null

  // `server/discover` — это ИМЕННО тот вызов, которым клиент выясняет версии.
  // Требовать от него уже знать версию значит сделать discover бесполезным.
  const isDiscover = method === 'server/discover'

  if (headerVersion && metaVersion && headerVersion !== metaVersion) {
    return makeError(id, ERR.HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header "${headerVersion}" does not match `
      + `_meta["${META.PROTOCOL_VERSION}"] "${metaVersion}" in the body.`)
  }

  const version = metaVersion || headerVersion
  if (version && !isSupportedVersion(version)) return unsupportedVersionError(id, version)

  if (!isDiscover) {
    if (!metaVersion) {
      return makeError(id, ERR.INVALID_PARAMS,
        `Missing required request metadata: params._meta["${META.PROTOCOL_VERSION}"]. `
        + 'Protocol 2026-07-28 has no handshake — every request carries its own version. '
        + 'Call server/discover to see supported versions.')
    }
    if (meta[META.CLIENT_CAPABILITIES] === undefined) {
      return makeError(id, ERR.INVALID_PARAMS,
        `Missing required request metadata: params._meta["${META.CLIENT_CAPABILITIES}"]. `
        + 'Send {} if the client has no capabilities to declare.')
    }
  }

  // `Mcp-Method` / `Mcp-Name`. Спецификация называет их REQUIRED, но требовать их
  // безусловно сегодня значит отказывать живым клиентам: ревизия свежая, и SDK их ещё
  // не шлют. Поэтому по умолчанию проверяем СОГЛАСОВАННОСТЬ (в ней и состоит защита:
  // балансировщик маршрутизирует по заголовку, сервер исполняет тело), а полную строгость
  // включает `MCP_STRICT_HEADERS=1` — когда экосистема догонит, флаг станет умолчанием.
  //
  // Отдельно: handleMessage вызывается и из тестов, и не только из HTTP, где заголовков
  // нет в принципе, поэтому «нет заголовков вообще» строгий режим тоже пропускает.
  const strict = process.env.MCP_STRICT_HEADERS === '1' && headers['mcp-protocol-version'] !== undefined

  const headerMethod = headers['mcp-method']
  if (headerMethod === undefined) {
    if (strict) {
      return makeError(id, ERR.HEADER_MISMATCH, 'Header mismatch: required header Mcp-Method is missing.')
    }
  } else if (String(headerMethod) !== method) {
    return makeError(id, ERR.HEADER_MISMATCH,
      `Header mismatch: Mcp-Method header "${headerMethod}" does not match body method "${method}".`)
  }

  const NAMED = { 'tools/call': params?.name, 'resources/read': params?.uri, 'prompts/get': params?.name }
  if (method in NAMED) {
    const expected = NAMED[method]
    const headerName = headers['mcp-name']
    if (headerName === undefined) {
      if (strict) {
        return makeError(id, ERR.HEADER_MISMATCH, `Header mismatch: required header Mcp-Name is missing for ${method}.`)
      }
    } else if (decodeHeaderValue(String(headerName)) !== expected) {
      return makeError(id, ERR.HEADER_MISMATCH,
        `Header mismatch: Mcp-Name header does not match the body value "${expected}".`)
    }
  }
  return null
}

/** Раскодировать значение заголовка в sentinel-формате `=?base64?…?=` (spec § Value Encoding). */
export function decodeHeaderValue(raw) {
  const m = /^=\?base64\?(.*)\?=$/.exec(raw)
  if (!m) return raw
  try { return Buffer.from(m[1], 'base64').toString('utf8') } catch { return raw }
}

// ── Обработка сообщения ────────────────────────────────────────────────────────

/**
 * Обработать одно JSON-RPC сообщение.
 * @param {object} message разобранное тело запроса
 * @param {{req?: object, headers?: object}} ctx контекст HTTP-запроса (нужен для прав на аккаунты)
 * @returns {Promise<object|null>} ответ или null для уведомлений
 */
export async function handleMessage(message, ctx = {}) {
  const headers = ctx.headers || ctx.req?.headers || {}

  if (Array.isArray(message)) {
    return makeError(null, ERR.INVALID_REQUEST,
      'Batch requests are not supported by this protocol revision. Send one JSON-RPC message per HTTP POST.')
  }
  if (!message || typeof message !== 'object') {
    return makeError(null, ERR.INVALID_REQUEST, 'Request body must be a single JSON-RPC 2.0 message object.')
  }
  // Клиент прислал ОТВЕТ на наш запрос (есть result/error, нет method). Своих запросов
  // к клиенту мы не делаем, но по спецификации такой вход принимается молча — 202.
  if (message.jsonrpc === '2.0' && message.method === undefined && ('result' in message || 'error' in message)) {
    return null
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return makeError(message.id, ERR.INVALID_REQUEST,
      'Invalid JSON-RPC envelope: both jsonrpc: "2.0" and a string method are required.')
  }

  const { id, method, params = {} } = message
  // Уведомления (без id) ответа не требуют — молча подтверждаем приём.
  const isNotification = id === undefined || id === null

  const era = detectEra(message, headers)
  const modern = era.modern

  if (modern && !isNotification) {
    const bad = checkModernEnvelope(message, headers)
    if (bad) return bad
  } else if (!modern && era.version && !isSupportedVersion(era.version)) {
    return unsupportedVersionError(id, era.version)
  }

  const ok = (value) => makeResult(id, value, { modern })

  try {
    switch (method) {
      /**
       * Обязательный метод ревизии 2026-07-28: одним запросом отдаёт версии, возможности
       * и личность. Реализован для ОБЕИХ эр — им же клиент и выясняет, что мы modern.
       */
      case 'server/discover':
        return makeResult(id, {
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: serverCapabilities(),
          instructions: INSTRUCTIONS,
          ...cacheFields(CACHE.DISCOVER_TTL_MS),
        }, { modern: true })

      /** Рукопожатие legacy-эры. Modern-клиенту здесь делать нечего. */
      case 'initialize': {
        if (modern) {
          return makeError(id, ERR.METHOD_NOT_FOUND,
            `Method "initialize" belongs to protocol revisions ${LEGACY_VERSIONS.join(', ')}. `
            + `This request declared ${era.version}, which has no handshake — call server/discover instead.`)
        }
        const asked = params.protocolVersion
        // Если клиент просит версию, которую мы знаем, — отвечаем ею же; иначе
        // предлагаем новейшую legacy, и клиент решает, продолжать ли.
        const version = isSupportedVersion(asked) ? asked : LEGACY_VERSIONS[0]
        return makeResult(id, {
          protocolVersion: version,
          capabilities: serverCapabilities(),
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }, { modern: false })
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return null

      /** `ping` удалён из протокола в 2026-07-28 — отвечаем только legacy-клиентам. */
      case 'ping':
        if (modern) {
          return makeError(id, ERR.METHOD_NOT_FOUND,
            'Method "ping" was removed in protocol revision 2026-07-28. Use server/discover as a liveness probe.')
        }
        return ok({})

      case 'tools/list': {
        const { page, nextCursor } = paginate(TOOLS, params.cursor)
        return ok({ tools: page, ...(nextCursor ? { nextCursor } : {}), ...cacheFields() })
      }

      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string' || !name) {
          return makeError(id, ERR.INVALID_PARAMS, 'Missing tool name (params.name).')
        }
        if (!TOOLS.some((t) => t.name === name)) {
          // Неизвестный инструмент — ошибка протокола, а не результат вызова
          // (spec § Error Handling): модель не починит опечатку, читая isError.
          return makeError(id, ERR.INVALID_PARAMS,
            `Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`)
        }
        try {
          const data = await callTool(name, params.arguments || {}, ctx)
          return ok({
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: data,
            isError: false,
          })
        } catch (err) {
          // Ошибка инструмента — это результат вызова, а не сбой протокола: модель
          // должна увидеть текст и исправиться, а не получить транспортную ошибку.
          if (err instanceof ToolError) {
            return ok({ content: [{ type: 'text', text: err.message }], isError: true })
          }
          throw err
        }
      }

      case 'resources/list': {
        const { page, nextCursor } = paginate(listResources(), params.cursor)
        return ok({ resources: page, ...(nextCursor ? { nextCursor } : {}), ...cacheFields() })
      }

      case 'resources/templates/list':
        return ok({ resourceTemplates: RESOURCE_TEMPLATES, ...cacheFields() })

      case 'resources/read': {
        const uri = params.uri
        if (typeof uri !== 'string' || !uri) {
          return makeError(id, ERR.INVALID_PARAMS, 'Missing resource URI (params.uri).')
        }
        const contents = readResource(uri)
        // Ревизия 2026-07-28 запретила код −32002 и велела отвечать −32602.
        if (!contents) {
          return makeError(id, ERR.INVALID_PARAMS,
            `Resource "${uri}" not found. Valid forms: murmex://module/<moduleKey> and murmex://help/<moduleKey>/<blockId>. `
            + `Known modules: ${listDescriptorKeys().join(', ')}.`)
        }
        return ok({ contents: [contents], ...cacheFields() })
      }

      case 'prompts/list':
        return ok({ prompts: PROMPTS, ...cacheFields() })

      case 'prompts/get': {
        const name = params.name
        const prompt = name ? getPrompt(name, params.arguments || {}) : null
        if (!prompt) {
          return makeError(id, ERR.INVALID_PARAMS,
            `Unknown prompt "${name}". Available: ${PROMPTS.map((p) => p.name).join(', ')}.`)
        }
        return ok(prompt)
      }

      default:
        if (isNotification) return null
        return makeError(id, ERR.METHOD_NOT_FOUND,
          `Method "${method}" is not supported by this server. Call server/discover to see its capabilities.`)
    }
  } catch (err) {
    if (err?.rpcCode) return makeError(id, err.rpcCode, err.message)
    return makeError(id, ERR.INTERNAL, err instanceof Error ? err.message : 'Internal server error')
  }
}

// ── HTTP-уровень ───────────────────────────────────────────────────────────────

/**
 * Разрешённые Origin. Спецификация Streamable HTTP требует проверять заголовок:
 * без этого сайт в браузере жертвы может дозвониться до MCP-сервера через DNS rebinding.
 * Запросы БЕЗ Origin (curl, сервер-к-серверу, MCP-клиенты вне браузера) пропускаем —
 * атака возможна только из браузера, а он Origin ставит всегда.
 *
 * Список настраивается через `MCP_ALLOWED_ORIGINS`: домен продакшена не должен жить
 * константой в исходнике, иначе каждый новый стенд — это правка кода и релиз.
 */
const DEFAULT_ORIGIN_HOSTS = ['myrmexgram.ai', 'www.myrmexgram.ai', 'myrmex.io', 'localhost', '127.0.0.1', '[::1]']

export function allowedOriginHosts() {
  const extra = String(process.env.MCP_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...DEFAULT_ORIGIN_HOSTS, ...extra])
}

export function originAllowed(origin) {
  if (!origin) return true
  try { return allowedOriginHosts().has(new URL(origin).hostname.toLowerCase()) } catch { return false }
}

/**
 * Проверки уровня HTTP, общие для запросов к MCP-эндпоинту.
 * @returns {{status: number, body: object}|null} ошибка или null, если всё в порядке
 */
export function checkHttpPreconditions(req) {
  if (!originAllowed(req.headers?.origin)) {
    // Спецификация: тело МОЖЕТ быть JSON-RPC ошибкой без id. Отдаём именно её —
    // клиент разбирает один формат, а не два.
    return { status: 403, body: makeError(null, ERR.INVALID_REQUEST, 'Origin not allowed') }
  }
  // Спецификация: клиент обязан слать MCP-Protocol-Version; при неизвестной версии
  // сервер ОБЯЗАН ответить 400 с UnsupportedProtocolVersionError. Если заголовка нет —
  // считаем 2025-03-26, как велит раздел обратной совместимости.
  const asked = req.headers?.['mcp-protocol-version']
  if (asked && !isSupportedVersion(String(asked))) {
    return { status: 400, body: unsupportedVersionError(null, String(asked)) }
  }
  return null
}

/** Express-обработчик POST: тело уже разобрано express.json(). */
export async function mcpPostHandler(req, res) {
  const bad = checkHttpPreconditions(req)
  if (bad) return res.status(bad.status).json(bad.body)

  const response = await handleMessage(req.body, { req, headers: req.headers })
  // Уведомление или ответ клиента: тела нет, по спецификации отвечаем 202.
  if (response === null) return res.status(202).end()

  // Статус — эро-зависимо. Ревизия 2026-07-28 требует 400/404 на конкретные ошибки:
  // по ним клиент отличает modern-сервер от legacy, не разбирая тело. Legacy-эра таких
  // требований не знала и ждёт 200 с телом ошибки — отдать ей 404 значит сломать её.
  //
  // Исключение — коды из диапазона, закреплённого за спецификацией (−32020…−32099).
  // Они существуют ТОЛЬКО в современном протоколе, и раз мы их вернули, значит говорим
  // на нём. UnsupportedProtocolVersion на 200 — худший из возможных ответов: клиент
  // просил версию, которой у нас нет, и по статусу «всё хорошо» решит, что мы legacy,
  // вместо того чтобы повторить запрос с версией из списка supported.
  const { modern } = detectEra(req.body, req.headers || {})
  const code = response.error?.code
  const specReserved = typeof code === 'number' && code <= -32020 && code >= -32099
  const status = response.error && (modern || specReserved) ? httpStatusForError(code) : 200
  res.status(status).json(response)
}

/**
 * GET на MCP-эндпоинт клиент шлёт, чтобы ОТКРЫТЬ SSE-поток для серверных сообщений.
 * В ревизии 2026-07-28 GET-эндпоинта нет вовсе, а раньше спецификация оставляла ровно
 * два ответа: `text/event-stream` или **405**. Мы поток не держим (серверных
 * уведомлений у нас нет), значит обязаны отдать 405 — иначе клиент получит 200 с JSON
 * и решит, что поток открыт.
 *
 * При этом по тому же адресу живёт REST-манифест «посмотреть глазами», и ломать его
 * нельзя — им уже пользуются. Различаем по Accept: просит SSE — 405, просит обычный
 * ответ — манифест.
 */
export function wantsEventStream(req) {
  return String(req.headers?.accept || '').includes('text/event-stream')
}

/** DELETE — завершение сессии. Сессий в протоколе больше нет; спецификация велит 405. */
export function mcpDeleteHandler(_req, res) {
  res.status(405).json(makeError(null, ERR.INVALID_REQUEST,
    'Protocol-level sessions were removed in revision 2026-07-28 and were never used by this server; there is nothing to terminate.'))
}

export { ASSUMED_LEGACY_VERSION }
