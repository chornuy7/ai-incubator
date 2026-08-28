/**
 * Поднять бэкенд ТОЛЬКО чтобы посмотреть живую документацию MCP (`/mcp-docs`).
 *
 * Зачем отдельно от `npm run dev`. Документацию часто открывают, когда основной дев-сервер
 * уже занят: чужой процесс держит 3001, а поднимать второй экземпляр на тех же данных
 * нельзя — при старте `reconcileStaleTasksOnBoot` помечает running-задачи как `stopped`,
 * то есть второй запуск ГЛУШИТ задачи первого. Поэтому здесь по умолчанию своя папка
 * данных и свой порт: смотреть протокол можно, сломать работающее — нет.
 *
 *   npm run mcp:docs                     # изолированные данные, порт 3011
 *   MCP_DOCS_DATA=real npm run mcp:docs  # настоящие данные (когда основной сервер не запущен)
 *   API_PORT=4000 npm run mcp:docs       # другой порт
 *
 * Схемы, инструменты, дескрипторы модулей и протокол живут в КОДЕ, а не в данных, —
 * в изолированном режиме они настоящие до последнего поля. Пустыми будут только
 * аккаунты, задачи и пользователи.
 */
// dotenv — ПЕРВЫМ делом: ниже мы решаем, выдавать ли временный ключ, и без `.env`
// решение принимается по пустому окружению. Ключ из файла при этом игнорировался,
// а в консоль печаталось «не задан» про то, что задано.
import 'dotenv/config'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const isolated = process.env.MCP_DOCS_DATA !== 'real'

if (isolated) {
  const dir = await mkdtemp(path.join(tmpdir(), 'murmex-mcp-docs-'))
  process.env.DATA_DIR = dir
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  process.env.USERS_FILE = path.join(dir, 'users.json')
  process.env.API_KEYS_FILE = path.join(dir, 'api-keys.json')
  // Файловый бэкенд принудительно: с Supabase «изолированно» не получится — он общий.
  process.env.DATA_BACKEND = ''
  console.log(`[mcp:docs] изолированные данные: ${dir}`)
  console.log('[mcp:docs] аккаунты/задачи/пользователи будут пустыми; схемы и протокол — настоящие')
} else {
  console.log('[mcp:docs] РАБОЧИЕ данные. Убедись, что основной дев-сервер не запущен: два процесса на одной папке глушат задачи друг друга.')
}

// Порт: свой, чтобы не конфликтовать с основным дев-сервером.
process.env.API_PORT = process.env.API_PORT || process.env.PORT || '3011'
// Страница — инструмент разработчика; здесь она нужна всегда, даже если задан SESSION_SECRET.
process.env.MCP_DOCS = '1'

// Ключ обязателен: без него /api/v1 закрыт и странице нечего показывать. Если в .env
// его нет, выдаём временный и печатаем — иначе первое открытие кончается 401 без объяснения.
if (!process.env.MURMEX_API_KEY && !process.env.API_SERVICE_KEY) {
  const { randomBytes } = await import('node:crypto')
  process.env.MURMEX_API_KEY = `aii_live_sk_${randomBytes(24).toString('hex')}`
  console.log(`[mcp:docs] MURMEX_API_KEY не задан — выдан временный на этот запуск:\n\n    ${process.env.MURMEX_API_KEY}\n`)
}

await import('../server/index.js')
