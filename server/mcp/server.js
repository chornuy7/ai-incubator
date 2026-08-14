/**
 * MCP-сервер Murmex: JSON-RPC 2.0 поверх Streamable HTTP.
 *
 * До этого по адресу `/api/v1/mcp` лежал REST-манифест, который MCP только назывался:
 * ни одного метода протокола, ни одной схемы. Подключиться к нему штатным MCP-клиентом
 * было нельзя — заказчик назвал это «разными планетами», и был прав.
 *
 * Транспорт: POST принимает одно JSON-RPC сообщение и отвечает одним JSON-ответом
 * (`application/json`). SSE-поток мы не открываем: серверных уведомлений у нас нет,
 * а спецификация разрешает отвечать телом, если сервер не инициирует поток сам.
 * GET на этом же адресе оставлен за старым манифестом — им уже пользуются.
 *
 * Ресурсы отдаются как `murmex://module/<key>` и `murmex://help/<key>/<block>`.
 */
import { TOOLS, ToolError, callTool } from './tools.js'
import { describeModule, listDescriptorKeys, getDescriptor } from './descriptors/index.js'

/** Версии протокола, с которыми умеем разговаривать. Первая — предпочитаемая. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const SERVER_INFO = { name: 'murmex', title: 'Murmex — управление Telegram-аккаунтами', version: '1.0.0' }

const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 }

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } })

/** Ресурсы: полное описание модуля и help по каждому его блоку. */
export function listResources() {
  const out = []
  for (const key of listDescriptorKeys()) {
    const desc = getDescriptor(key)
    out.push({
      uri: `murmex://module/${key}`,
      name: `module-${key}`,
      title: `${desc.title} — полное описание`,
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
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }
  }
  const help = /^murmex:\/\/help\/([\w-]+)\/([\w-]+)$/.exec(uri)
  if (help) {
    const data = describeModule(help[1])
    const block = data?.blocks.find((b) => b.id === help[2])
    if (!block) return null
    return { uri, mimeType: 'application/json', text: JSON.stringify({ module: help[1], ...block }, null, 2) }
  }
  return null
}

/**
 * Обработать одно JSON-RPC сообщение.
 * @param {object} message разобранное тело запроса
 * @param {{req: object}} ctx контекст HTTP-запроса (нужен для проверки прав на аккаунты)
 * @returns {Promise<object|null>} ответ или null для уведомлений
 */
export async function handleMessage(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, ERR.INVALID_REQUEST, 'Ожидается одно JSON-RPC сообщение. Пакетные запросы протоколом не поддерживаются.')
  }
  // Клиент прислал ОТВЕТ на наш запрос (есть result/error, нет method). Своих запросов
  // к клиенту мы не делаем, но по спецификации такой вход принимается молча — 202.
  if (message.jsonrpc === '2.0' && message.method === undefined && ('result' in message || 'error' in message)) {
    return null
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return failure(message.id, ERR.INVALID_REQUEST, 'Неверный конверт JSON-RPC: нужны jsonrpc: "2.0" и method')
  }

  const { id, method, params = {} } = message
  // Уведомления (без id) ответа не требуют — молча подтверждаем приём.
  const isNotification = id === undefined || id === null

  try {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion
        // Если клиент просит версию, которую мы знаем, — отвечаем ею же; иначе
        // предлагаем свою последнюю, и клиент решает, продолжать ли.
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0]
        return result(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Порядок работы: list_modules → describe_module (полная схема параметров и ограничений) → '
            + 'validate_task (проверка черновика без запуска) → estimate_task (цена и время) → create_task. '
            + 'Схема есть не у всех модулей: у неописанных described = false, полагаться на их список полей нельзя.',
        })
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return null

      case 'ping':
        return result(id, {})

      case 'tools/list':
        return result(id, { tools: TOOLS })

      case 'tools/call': {
        const name = params.name
        if (!name) return failure(id, ERR.INVALID_PARAMS, 'Не указано имя инструмента (params.name)')
        try {
          const data = await callTool(name, params.arguments || {}, ctx)
          return result(id, {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: data,
            isError: false,
          })
        } catch (err) {
          // Ошибка инструмента — это результат вызова, а не сбой протокола: модель
          // должна увидеть текст и исправиться, а не получить транспортную ошибку.
          if (err instanceof ToolError) {
            return result(id, { content: [{ type: 'text', text: err.message }], isError: true })
          }
          throw err
        }
      }

      case 'resources/list':
        return result(id, { resources: listResources() })

      case 'resources/read': {
        const uri = params.uri
        const contents = uri ? readResource(uri) : null
        if (!contents) return failure(id, ERR.INVALID_PARAMS, `Ресурс не найден: ${uri}`)
        return result(id, { contents: [contents] })
      }

      case 'prompts/list':
        return result(id, { prompts: [] })

      default:
        if (isNotification) return null
        return failure(id, ERR.METHOD_NOT_FOUND, `Метод «${method}» не поддерживается`)
    }
  } catch (err) {
    return failure(id, ERR.INTERNAL, err instanceof Error ? err.message : 'Внутренняя ошибка')
  }
}

/**
 * Разрешённые Origin. Спецификация Streamable HTTP требует проверять заголовок:
 * без этого сайт в браузере жертвы может дозвониться до MCP-сервера через DNS rebinding.
 * Запросы БЕЗ Origin (curl, сервер-к-серверу, MCP-клиенты вне браузера) пропускаем —
 * атака возможна только из браузера, а он Origin ставит всегда.
 */
const ALLOWED_ORIGIN_HOSTS = new Set(['myrmexgram.ai', 'www.myrmexgram.ai', 'myrmex.io', 'localhost', '127.0.0.1'])

export function originAllowed(origin) {
  if (!origin) return true
  try { return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname) } catch { return false }
}

/**
 * Проверки уровня HTTP, общие для запросов к MCP-эндпоинту.
 * @returns {{status: number, body: object}|null} ошибка или null, если всё в порядке
 */
export function checkHttpPreconditions(req) {
  if (!originAllowed(req.headers?.origin)) {
    return { status: 403, body: { error: 'Origin не разрешён' } }
  }
  // Спецификация: клиент обязан слать MCP-Protocol-Version на всех запросах после
  // initialize; при неизвестной версии сервер ОБЯЗАН ответить 400. Если заголовка нет —
  // считаем 2025-03-26, как велит раздел обратной совместимости.
  const asked = req.headers?.['mcp-protocol-version']
  if (asked && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(asked))) {
    return {
      status: 400,
      body: { error: `Версия протокола ${asked} не поддерживается. Доступны: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}` },
    }
  }
  return null
}

/** Express-обработчик POST: тело уже разобрано express.json(). */
export async function mcpPostHandler(req, res) {
  const bad = checkHttpPreconditions(req)
  if (bad) return res.status(bad.status).json(bad.body)

  const response = await handleMessage(req.body, { req })
  // Уведомление или ответ клиента: тела нет, по спецификации отвечаем 202.
  if (response === null) return res.status(202).end()
  res.json(response)
}

/**
 * GET на MCP-эндпоинт клиент шлёт, чтобы ОТКРЫТЬ SSE-поток для серверных сообщений.
 * Спецификация оставляет ровно два варианта ответа: `text/event-stream` или **405**.
 * Мы поток не держим (серверных уведомлений у нас нет), значит обязаны отдать 405 —
 * иначе клиент получит 200 с JSON и решит, что поток открыт.
 *
 * При этом по тому же адресу живёт REST-манифест «посмотреть глазами», и ломать его
 * нельзя — им уже пользуются. Различаем по Accept: просит SSE — 405, просит обычный
 * ответ — манифест.
 */
export function wantsEventStream(req) {
  return String(req.headers?.accept || '').includes('text/event-stream')
}

/** DELETE — завершение сессии. Сессий мы не держим, спецификация разрешает 405. */
export function mcpDeleteHandler(_req, res) {
  res.status(405).json({ error: 'Сессии не используются — завершать нечего' })
}
