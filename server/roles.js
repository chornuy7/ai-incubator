/**
 * RBAC: роли и права доступа (§8.1, docs/CONTRACT-rbac.md).
 * Главный админ создаёт роли и раздаёт доступы к модулям, блокам внутри модулей и
 * ресурсам (папки/каналы/таймеры/шаблоны). Каждый доступ — allow|deny («2 чекбокса»:
 * дать / убрать доступ). По умолчанию — deny (нет доступа, подсвечивается в UI).
 * Хранение — JSON data/roles.json; путь через env ROLES_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { MODULE_LABELS } from './lib/accountLocks.js'
import { listFolders } from './targetFolders.js'
import { listChannels } from './channels.js'

const ROLES_FILE = process.env.ROLES_FILE || dataPath('roles.json')

export const ALLOW = 'allow'
export const DENY = 'deny'

/** Встроенная роль главного админа — обходит проверки (bypass). Не удаляется/не редактируется. */
export const ADMIN_ROLE_ID = 'role_admin'

/** Единый словарь блоков внутри модуля (§8.1 «блоки в модулях»). */
export const BLOCKS = [
  { key: 'run', label: 'Запуск / остановка' },
  { key: 'settings', label: 'Настройки и пресеты' },
  { key: 'targets', label: 'Целевые каналы/группы' },
  { key: 'templates', label: 'Шаблоны' },
  { key: 'results', label: 'Результаты' },
  { key: 'logs', label: 'Логи' },
]

/** Типы ресурсов с индивидуальным доступом (§8.1). folders/channels — по элементам. */
export const RESOURCE_TYPES = [
  { type: 'folders', label: 'Папки целей', perItem: true },
  { type: 'channels', label: 'Целевые каналы', perItem: true },
  { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
  { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
]

/** Нормализовать значение доступа: всё, что не 'allow', — deny. @param {*} v */
function normPerm(v) {
  return v === ALLOW ? ALLOW : DENY
}

/** Нормализовать карту `key → allow|deny`. @param {*} obj */
function normPermMap(obj) {
  /** @type {Record<string,'allow'|'deny'>} */
  const out = {}
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) out[k] = normPerm(v)
  }
  return out
}

/** Привести вход к чистой роли (без служебных полей). @param {object} input */
export function normalizeRole(input = {}) {
  const p = input.permissions || {}
  const r = p.resources || {}
  return {
    name: String(input.name ?? '').trim(),
    isTemplate: !!input.isTemplate,
    permissions: {
      modules: normPermMap(p.modules),
      blocks: normPermMap(p.blocks), // ключ = `${moduleKey}:${blockKey}`
      resources: {
        folders: normPermMap(r.folders),
        channels: normPermMap(r.channels),
        timers: normPerm(r.timers),
        searchTemplates: normPerm(r.searchTemplates),
      },
    },
  }
}

const moduleMap = (keys, val) => Object.fromEntries(keys.map((k) => [k, val]))
const blockMap = (keys, blocks, val) => Object.fromEntries(keys.flatMap((k) => blocks.map((b) => [`${k}:${b}`, val])))

/**
 * Стартовый набор ролей (§6-решение: Admin / Operator / Sales / Viewer).
 *  - Администратор — bypass (всё);
 *  - Оператор — запуск/настройки/результаты/логи всех модулей + таймеры/шаблоны;
 *  - Sales — только диалоговые модули на запуск + просмотр результатов/логов везде (CRM-профиль);
 *  - Viewer — только чтение (результаты/логи), без запуска и настроек.
 */
function defaultRoles() {
  const now = Date.now()
  const mods = Object.keys(MODULE_LABELS)
  const SALES = mods.filter((k) => ['neuro-chatting', 'neuro-dialogs', 'mailing'].includes(k))
  const roleTpl = (id, name, permissions) => ({ id, name, builtin: false, isTemplate: true, permissions, createdAt: now, updatedAt: now })
  return [
    {
      id: ADMIN_ROLE_ID,
      name: 'Администратор',
      builtin: true,
      isTemplate: false,
      permissions: { modules: {}, blocks: {}, resources: { folders: {}, channels: {}, timers: ALLOW, searchTemplates: ALLOW } },
      createdAt: now,
      updatedAt: now,
    },
    roleTpl('role_operator', 'Оператор', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, ['run', 'settings', 'targets', 'results', 'logs'], ALLOW),
      resources: { folders: {}, channels: {}, timers: ALLOW, searchTemplates: ALLOW },
    }),
    roleTpl('role_sales', 'Sales', {
      modules: moduleMap(mods, ALLOW),
      blocks: { ...blockMap(mods, ['results', 'logs'], ALLOW), ...blockMap(SALES, ['run'], ALLOW) },
      resources: { folders: {}, channels: {}, timers: DENY, searchTemplates: DENY },
    }),
    roleTpl('role_viewer', 'Viewer', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, ['results', 'logs'], ALLOW),
      resources: { folders: {}, channels: {}, timers: DENY, searchTemplates: DENY },
    }),
  ]
}

export async function listRoles() {
  const roles = await readJson(ROLES_FILE, null)
  if (!Array.isArray(roles)) {
    const seed = defaultRoles()
    await writeJson(ROLES_FILE, seed)
    return seed
  }
  // Разовая миграция старых инсталляций: если НЕТ ни одной из §6-ролей
  // (Operator/Sales/Viewer) — добавляем их, не трогая существующие/пользовательские.
  // Гейт «ни одной» защищает от воскрешения одной удалённой дефолт-роли.
  const have = new Set(roles.map((r) => r.id))
  const sixIds = ['role_operator', 'role_sales', 'role_viewer']
  if (!sixIds.some((id) => have.has(id))) {
    const missing = defaultRoles().filter((r) => r.id !== ADMIN_ROLE_ID && !have.has(r.id))
    if (missing.length) {
      const merged = [...roles, ...missing]
      await writeJson(ROLES_FILE, merged)
      return merged
    }
  }
  return roles
}

export async function getRole(id) {
  const roles = await listRoles()
  return roles.find((r) => r.id === id) || null
}

/** Создать роль. @param {object} input @throws при пустом имени */
export async function createRole(input) {
  const clean = normalizeRole(input)
  if (!clean.name) throw new Error('Укажите название роли')
  const roles = await listRoles()
  const role = {
    id: `role_${crypto.randomUUID().slice(0, 8)}`,
    builtin: false,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  roles.push(role)
  await writeJson(ROLES_FILE, roles)
  return role
}

/**
 * Обновить роль (имя и/или права). Встроенного админа переименовать можно, но права —
 * нет (он всегда bypass, менять нечего). @param {string} id @param {object} patch
 */
export async function updateRole(id, patch = {}) {
  const roles = await listRoles()
  const i = roles.findIndex((r) => r.id === id)
  if (i === -1) return null
  const clean = normalizeRole({ ...roles[i], ...patch })
  if (!clean.name) throw new Error('Название роли не может быть пустым')
  roles[i] = {
    ...roles[i],
    name: clean.name,
    isTemplate: clean.isTemplate,
    // Права админа неизменяемы (bypass); у остальных — обновляем.
    ...(roles[i].id === ADMIN_ROLE_ID ? {} : { permissions: clean.permissions }),
    updatedAt: Date.now(),
  }
  await writeJson(ROLES_FILE, roles)
  return roles[i]
}

/** Удалить роль (кроме встроенных). @param {string} id */
export async function deleteRole(id) {
  const roles = await listRoles()
  const target = roles.find((r) => r.id === id)
  if (!target) return false
  if (target.builtin) throw new Error('Встроенную роль удалить нельзя')
  const next = roles.filter((r) => r.id !== id)
  await writeJson(ROLES_FILE, next)
  return true
}

/**
 * Каталог того, что можно раздавать: модули × блоки + ресурсы (с реальными элементами).
 * Фронт рендерит матрицу прав из этого каталога.
 */
export async function buildCatalog() {
  const modules = Object.entries(MODULE_LABELS).map(([key, label]) => ({ key, label }))
  const [folders, channels] = await Promise.all([listFolders(), listChannels()])
  const resources = [
    { type: 'folders', label: 'Папки целей', perItem: true, items: folders.map((f) => ({ id: f.id, label: f.name || f.id })) },
    { type: 'channels', label: 'Целевые каналы', perItem: true, items: channels.map((c) => ({ id: c.id, label: c.title || (c.username ? '@' + c.username : c.id) })) },
    { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
    { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
  ]
  return { modules, blocks: BLOCKS, resources }
}

/**
 * Разрешён ли доступ роли к цели. Чистая функция (юнит-тест + будущий enforcement).
 * Админ (builtin ADMIN_ROLE_ID) — всегда true. По умолчанию — deny.
 * @param {object|null} role
 * @param {'module'|'block'|'folder'|'channel'|'timers'|'searchTemplates'} kind
 * @param {string} [key]
 */
export function can(role, kind, key) {
  if (!role) return false
  if (role.builtin && role.id === ADMIN_ROLE_ID) return true
  const p = role.permissions || {}
  switch (kind) {
    case 'module': return p.modules?.[key] === ALLOW
    case 'block': return p.blocks?.[key] === ALLOW
    case 'folder': return p.resources?.folders?.[key] === ALLOW
    case 'channel': return p.resources?.channels?.[key] === ALLOW
    case 'timers': return p.resources?.timers === ALLOW
    case 'searchTemplates': return p.resources?.searchTemplates === ALLOW
    default: return false
  }
}
