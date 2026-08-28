/**
 * Живая документация MCP: одна страница, которая всё, что показывает, читает у самого
 * сервера.
 *
 * Почему не markdown. Документация, написанная руками, расходится с кодом — этот раздел
 * заведён ровно после того, как расхождение схемы и реальности остановило заказчику
 * разработку оркестратора. Страница не хранит ни одного факта о протоколе: список
 * инструментов, схемы, дескрипторы модулей, версии и возможности она берёт живыми
 * запросами. Устареть ей нечем.
 *
 * Плюс к этому у каждого блока есть «Run»: видно не только описание запроса, но и
 * настоящий ответ этого сервера — вместе с заголовками транспорта, которые тоже часть
 * контракта и которые обычно узнают, только когда они не совпали.
 *
 * ДОСТУП. Сама страница ключа не требует — иначе её нельзя было бы открыть, чтобы ключ
 * ввести. Ключ живёт в браузере и подставляется её скриптом в запросы к `/api/v1/*`,
 * которые как были, так и остаются закрытыми. На проде (задан `SESSION_SECRET`) страница
 * выключена, пока явно не включат `MCP_DOCS=1`: это инструмент разработчика, и висеть
 * открытым на боевом домене ему незачем.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, 'docs', 'index.html')
const POLICY_PAGE = path.join(HERE, 'docs', 'policy.html')

/**
 * Путь страницы. Вне `/api`, чтобы её не закрывал ни sessionGuard, ни requireApiKey.
 *
 * Регистрируется РАНЬШЕ SPA-фолбэка (`server/index.js`, ~строка 67 против ~2078): Express
 * матчит в порядке объявления, поэтому фронт этот адрес не перехватит. У SPA своего
 * маршрута `/docs` нет — проверено по списку роутов, коллизии не будет.
 */
export const MCP_DOCS_PATH = '/docs/mcp'

/** Прежний адрес. Наружу не выкатывался, но остаётся редиректом — ссылки уже разошлись. */
export const MCP_DOCS_LEGACY_PATH = '/mcp-docs'

/**
 * Политика использования данных — `resource_policy_uri` из метаданных RFC 9728.
 *
 * Доступна ВСЕГДА, в отличие от самой документации. Её читает клиент, только что
 * получивший 401 и пошедший по ссылке из метаданных; на проде документация выключена, а
 * политика обязана открываться — иначе ссылка снова будет вести в никуда, ровно как
 * выдуманный адрес до неё. Секретов на странице нет: это статический текст.
 */
export const MCP_POLICY_PATH = '/docs/mcp/policy'

/** Включена ли страница: локально да, на проде — только по явному флагу. */
export function docsEnabled() {
  if (process.env.MCP_DOCS === '1') return true
  if (process.env.MCP_DOCS === '0') return false
  return !process.env.SESSION_SECRET
}

/**
 * Отдать статическую страницу. Читаем с диска на каждый запрос: правка видна по F5,
 * без перезапуска бэкенда. Файлы маленькие, и это не горячий путь.
 */
async function sendPage(res, file, what) {
  try {
    res.type('html').send(await readFile(file, 'utf8'))
  } catch (err) {
    res.status(500).type('text/plain').send(`Could not read the ${what}: ${err instanceof Error ? err.message : err}`)
  }
}

export function mountMcpDocs(app) {
  // Политика — ПЕРВОЙ и без гейта: на неё ссылаются метаданные ресурса, и клиент идёт
  // сюда сразу после 401. Выключать её вместе с документацией нельзя.
  app.get(MCP_POLICY_PATH, (_req, res) => sendPage(res, POLICY_PAGE, 'policy page'))
  app.get(`${MCP_POLICY_PATH}/`, (_req, res) => res.redirect(MCP_POLICY_PATH))

  app.get(MCP_DOCS_PATH, async (_req, res) => {
    if (!docsEnabled()) {
      return res.status(404).type('text/plain').send(
        'MCP docs are disabled on this deployment. Set MCP_DOCS=1 to enable them.\n'
        + `The data use policy stays available at ${MCP_POLICY_PATH}.`,
      )
    }
    await sendPage(res, PAGE, 'docs page')
  })
  // Со слэшем на конце — тот же ответ: иначе половина попыток открыть кончается 404.
  app.get(`${MCP_DOCS_PATH}/`, (_req, res) => res.redirect(MCP_DOCS_PATH))
  // Прежний адрес. Редирект, а не 404: адрес успел попасть в документацию и закладки,
  // а молчаливый 404 здесь неотличим от «страницы вообще нет».
  app.get(MCP_DOCS_LEGACY_PATH, (_req, res) => res.redirect(301, MCP_DOCS_PATH))
}
