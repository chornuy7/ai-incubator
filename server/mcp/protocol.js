/**
 * Константы и правила протокола MCP — одно место, где записано, «как принято по спецификации».
 *
 * Сервер двухэрный (dual-era, см. spec 2026-07-28 § Backward Compatibility):
 *   • MODERN (2026-07-28) — рукопожатия нет. Каждый запрос сам несёт версию, возможности
 *     и личность клиента в `params._meta`; сервер отвечает на каждый запрос независимо.
 *   • LEGACY (2025-11-25 и раньше) — старое рукопожатие `initialize` + `notifications/initialized`.
 *
 * Эру определяем по тому, КАК клиент пришёл: `initialize` → legacy; `_meta` с версией
 * из MODERN_VERSIONS → modern. Обе обслуживаются на одном эндпоинте одновременно —
 * спецификация это прямо разрешает, а нам это нужно: заказчик уже подключился
 * legacy-клиентом, и ломать его нельзя.
 */

/** Версии с per-request метаданными (без рукопожатия). Первая — предпочитаемая. */
export const MODERN_VERSIONS = ['2026-07-28']

/** Версии с рукопожатием `initialize`. Первая — предпочитаемая среди них. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Всё, что сервер понимает. Порядок = приоритет, от нового к старому. */
export const SUPPORTED_PROTOCOL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

/** Версия по умолчанию для запроса без заголовка/`_meta` (spec: раздел обратной совместимости). */
export const ASSUMED_LEGACY_VERSION = '2025-03-26'

export const isModernVersion = (v) => MODERN_VERSIONS.includes(String(v))
export const isLegacyVersion = (v) => LEGACY_VERSIONS.includes(String(v))
export const isSupportedVersion = (v) => SUPPORTED_PROTOCOL_VERSIONS.includes(String(v))

/** Зарезервированные ключи `_meta`. Строкой, а не по памяти: опечатка тут не видна глазом. */
export const META = {
  PROTOCOL_VERSION: 'io.modelcontextprotocol/protocolVersion',
  CLIENT_INFO: 'io.modelcontextprotocol/clientInfo',
  CLIENT_CAPABILITIES: 'io.modelcontextprotocol/clientCapabilities',
  SERVER_INFO: 'io.modelcontextprotocol/serverInfo',
  LOG_LEVEL: 'io.modelcontextprotocol/logLevel',
}

/**
 * Коды ошибок.
 *
 * Диапазон −32020…−32099 спецификация забрала себе целиком: реализация НЕ ИМЕЕТ ПРАВА
 * придумывать там свои коды. Поэтому здесь только то, что определено спекой.
 * −32002 (resource not found) в 2026-07-28 запрещён и заменён на −32602.
 */
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
}

/** Личность сервера. Уезжает и в `server/discover`, и в `_meta` каждого modern-ответа. */
export const SERVER_INFO = {
  name: 'murmex',
  title: 'Murmex — Telegram account operations',
  version: '2.0.0',
  websiteUrl: 'https://myrmexgram.ai',
}

/**
 * Сколько клиенту разрешено кэшировать списки (`CacheableResult`, spec 2026-07-28).
 * `private` — потому что состав инструментов и ресурсов зависит от ключа: общий
 * кэш на промежуточном прокси отдал бы одному тенанту схему другого.
 */
export const CACHE = {
  LIST_TTL_MS: 300_000,
  DISCOVER_TTL_MS: 3_600_000,
  SCOPE: 'private',
}

/** Сколько элементов отдаём за одну страницу списка (`nextCursor`). */
export const PAGE_SIZE = 50

/** Возможности сервера — один объект для `initialize` и для `server/discover`. */
export function serverCapabilities() {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    prompts: { listChanged: false },
  }
}

/** JSON-RPC ответ. `resultType` добавляем только modern-клиентам — legacy его не знает. */
export function makeResult(id, value, { modern = false } = {}) {
  const result = modern
    ? { resultType: 'complete', ...value, _meta: { ...(value._meta || {}), [META.SERVER_INFO]: SERVER_INFO } }
    : { ...value }
  return { jsonrpc: '2.0', id, result }
}

/** JSON-RPC ошибка. `id` обязателен по спецификации; null — только если id прочитать не удалось. */
export function makeError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/** Ошибка версии — с полным списком поддерживаемых, чтобы клиент мог повторить запрос. */
export function unsupportedVersionError(id, requested) {
  return makeError(id, ERR.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
    supported: SUPPORTED_PROTOCOL_VERSIONS,
    requested: requested ?? null,
  })
}

/**
 * HTTP-статус, которым отдаём JSON-RPC ошибку.
 *
 * Спецификация 2026-07-28 требует конкретных статусов: по ним клиент отличает
 * modern-сервер от legacy, не разбирая тело. Отдать всё двухсоткой — значит сломать
 * определение эры на той стороне.
 */
export function httpStatusForError(code) {
  switch (code) {
    case ERR.METHOD_NOT_FOUND: return 404
    case ERR.HEADER_MISMATCH:
    case ERR.MISSING_CLIENT_CAPABILITY:
    case ERR.UNSUPPORTED_PROTOCOL_VERSION:
    case ERR.INVALID_REQUEST:
    case ERR.PARSE: return 400
    case ERR.INTERNAL: return 500
    default: return 200
  }
}

/** Достать `_meta` из params, не падая на кривом входе. */
export function requestMeta(params) {
  const meta = params && typeof params === 'object' ? params._meta : null
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
}

/**
 * Нарезать список на страницу. Курсор — просто смещение в base64url: список
 * детерминированный и целиком в памяти, поэтому непрозрачный курсор здесь честнее
 * выглядел бы, чем работал.
 * @returns {{page: any[], nextCursor?: string}}
 */
export function paginate(items, cursor, size = PAGE_SIZE) {
  let start = 0
  if (cursor) {
    const decoded = Number.parseInt(Buffer.from(String(cursor), 'base64url').toString('utf8'), 10)
    if (!Number.isInteger(decoded) || decoded < 0 || decoded > items.length) {
      throw Object.assign(new Error(`Invalid cursor "${cursor}"`), { rpcCode: ERR.INVALID_PARAMS })
    }
    start = decoded
  }
  const page = items.slice(start, start + size)
  const end = start + page.length
  return end < items.length ? { page, nextCursor: Buffer.from(String(end)).toString('base64url') } : { page }
}

/** Поля кэширования, обязательные на результатах списков (`CacheableResult`). */
export function cacheFields(ttlMs = CACHE.LIST_TTL_MS) {
  return { ttlMs, cacheScope: CACHE.SCOPE }
}
