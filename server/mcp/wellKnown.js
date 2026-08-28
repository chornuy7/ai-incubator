/**
 * Обнаружение авторизации для MCP-эндпоинта: RFC 9728 (OAuth 2.0 Protected Resource
 * Metadata) + корректный вызов `WWW-Authenticate` на 401.
 *
 * Зачем это при обычном bearer-ключе. MCP-клиент, получив 401, по спецификации идёт
 * читать `resource_metadata` из заголовка. Раньше он получал голый 401 без заголовка и
 * не мог понять НИЧЕГО: ни какой это ресурс, ни куда идти за токеном, ни в чём ошибка —
 * «нужен ключ» на русском в теле JSON человеку понятно, клиенту нет.
 *
 * Честность важнее полноты: мы НЕ объявляем несуществующий authorization server.
 * Если OAuth не настроен (`MCP_AUTHORIZATION_SERVERS` пуст), документ так и говорит —
 * ключ выдаётся вне протокола. Обещать клиенту OAuth-поток, которого нет, хуже, чем
 * не обещать ничего: он потратит раунд на discovery и упрётся в 404.
 */

/** Путь MCP-эндпоинта относительно корня. Он же — идентификатор ресурса в OAuth. */
export const MCP_RESOURCE_PATH = '/api/v1/mcp'

/**
 * Канонический URI ресурса. RFC 8707 требует именно абсолютный URI без фрагмента;
 * берём из `PUBLIC_BASE_URL`, а при его отсутствии собираем из заголовков запроса —
 * иначе за прокси в документ попадёт внутренний адрес, недостижимый для клиента.
 */
export function resourceUri(req) {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (base) return `${base}${MCP_RESOURCE_PATH}`
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https').split(',')[0].trim()
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost').split(',')[0].trim()
  return `${proto}://${host}${MCP_RESOURCE_PATH}`
}

/** URL документа метаданных: `/.well-known/oauth-protected-resource` + путь ресурса. */
export function resourceMetadataUrl(req) {
  const uri = new URL(resourceUri(req))
  return `${uri.origin}/.well-known/oauth-protected-resource${uri.pathname}`
}

/** Список authorization server'ов — только если он действительно настроен. */
function authorizationServers() {
  return String(process.env.MCP_AUTHORIZATION_SERVERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Документ RFC 9728.
 *
 * `resource_documentation` СЧИТАЕТСЯ от реального маршрута, а не пишется константой.
 * Раньше здесь стоял захардкоженный адрес страницы, которой на тот момент не
 * существовало: SPA ловит любой неизвестный GET и уводит на логин или в панель, поэтому
 * клиент, пришедший по ссылке из метаданных, получал форму входа вместо документации.
 * Ссылка на несуществующую страницу хуже отсутствующей — по ней идут и упираются.
 *
 * Поэтому берём `MCP_DOCS_PATH` из самого модуля страницы: переедет маршрут — переедет и
 * ссылка. И отдаём поле, только если страница включена: на проде она выключена, пока не
 * задан `MCP_DOCS=1`, и обещать её там нельзя.
 */
export async function protectedResourceMetadata(req) {
  const servers = authorizationServers()
  const { docsEnabled, MCP_DOCS_PATH, MCP_POLICY_PATH } = await import('./docs.js')
  const abs = (p) => new URL(p, resourceUri(req)).href
  // Документация может быть выключена, политика — нет: её читает клиент, только что
  // получивший 401, и на проде она обязана открываться.
  const docs = docsEnabled() ? abs(MCP_DOCS_PATH) : null
  return {
    resource: resourceUri(req),
    // `header` и только он: спецификация запрещает передавать токен строкой запроса.
    bearer_methods_supported: ['header'],
    resource_name: 'Murmex MCP',
    ...(docs ? { resource_documentation: docs } : {}),
    // Политика обращения с ДАННЫМИ (RFC 9728 §2), а не инструкция по входу — см. ниже.
    resource_policy_uri: abs(MCP_POLICY_PATH),
    ...(servers.length
      ? { authorization_servers: servers }
      // Поля нет намеренно — см. заголовок файла: OAuth-сервера у нас не развёрнуто,
      // и обещать клиенту поток, которого не существует, значит стоить ему раунда
      // discovery и 404 в конце.
      //
      // ЗДЕСЬ НЕ МЕСТО ССЫЛКЕ НА ОПИСАНИЕ АВТОРИЗАЦИИ. В этой ветке когда-то стоял
      // `resource_policy_uri`, указывающий на раздел «как авторизоваться», — как будто
      // отсутствующему `authorization_servers` нужна замена. Она не нужна, и поле не про
      // это: RFC 9728 §2 определяет `resource_policy_uri` как «информация о требованиях
      // ресурса к тому, КАК КЛИЕНТ МОЖЕТ ИСПОЛЬЗОВАТЬ ПОЛУЧЕННЫЕ ДАННЫЕ», то есть политика
      // обращения с данными, а не инструкция по входу. Про вход клиенту отвечают
      // `authorization_servers` и заголовок `WWW-Authenticate`.
      //
      // Поле вернулось выше — уже по назначению и с настоящей страницей: `docs/policy.html`.
      : { resource_signing_alg_values_supported: [] }),
  }
}

/**
 * Собрать значение `WWW-Authenticate`.
 * @param {object} req запрос
 * @param {{error?: string, description?: string, scope?: string}} opts
 */
export function wwwAuthenticate(req, opts = {}) {
  const parts = ['Bearer realm="murmex"']
  if (opts.error) parts.push(`error="${opts.error}"`)
  if (opts.description) parts.push(`error_description="${String(opts.description).replace(/"/g, "'")}"`)
  if (opts.scope) parts.push(`scope="${opts.scope}"`)
  parts.push(`resource_metadata="${resourceMetadataUrl(req)}"`)
  return parts.join(', ')
}

/**
 * Смонтировать `.well-known`-маршруты. Ставится НА КОРЕНЬ приложения, а не под
 * `/api/v1`: RFC 9728 задаёт путь от origin, и под префиксом клиент его не найдёт.
 *
 * Документ публичный по определению — он нужен ровно тем, у кого ещё нет токена,
 * поэтому ключа не требует и никаких данных о пользователе не содержит.
 */
export function mountWellKnown(app) {
  const handler = async (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600')
    res.json(await protectedResourceMetadata(req))
  }
  app.get('/.well-known/oauth-protected-resource', handler)
  app.get(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`, handler)
}
