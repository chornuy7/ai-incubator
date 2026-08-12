/**
 * RBAC: роли и права доступа (§8.1, docs/CONTRACT-rbac.md).
 * Главный админ создаёт роли и раздаёт доступы к модулям, блокам внутри модулей и
 * ресурсам (папки/каналы/таймеры/шаблоны). Каждый доступ — allow|deny («2 чекбокса»:
 * дать / убрать доступ). По умолчанию — deny (нет доступа, подсвечивается в UI).
 * Хранение — JSON data/roles.json; путь через env ROLES_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sbRoles() { return supabaseEnabled() ? getSupabase() : null }
const rowToRole = (r) => ({ id: r.id, name: r.name, permissions: r.permissions || {}, builtin: !!r.builtin, userId: r.user_id || undefined })
// §11.3: user_id — кто создал роль (до применения миграции колонки нет, см. ownerColumn).
const roleToRow = (r) => ({ id: r.id, name: r.name, permissions: r.permissions || {}, builtin: !!r.builtin, user_id: r.userId || null })
import { MODULE_LABELS } from './lib/accountLocks.js'
import { listFolders } from './targetFolders.js'
import { listChannels } from './channels.js'
import { loadAllMeta } from './accountsMeta.js'
import { listGroups } from './accountGroups.js'

// Путь — ФУНКЦИЯ, а не константа: при вычислении на импорте тесты, выставляющие
// env позже, писали бы в боевые data/. Так и случилось — прогон накопил там
// 22 лишние роли и 36 пользователей.
const ROLES_FILE = () => process.env.ROLES_FILE || dataPath('roles.json')

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

/**
 * Разделы навигации, доступ к которым выдаётся ролью (§8.1 «доступ на всё, не только модули»).
 * Ключ = путь роутинга. НЕ включает: админ-страницы (роли/пользователи — только админ) и
 * «всегда-доступный» минимум (Мой аккаунт, Поддержка). По умолчанию — deny (не показывать).
 */
export const SECTIONS = [
  { key: '/panel', label: 'Менеджер аккаунтов' },
  { key: '/panel/proxies', label: 'Прокси' },
  { key: '/panel/automation', label: 'Автоматизация' },
  { key: '/panel/goals', label: 'Цели' },
  { key: '/panel/campaign', label: 'Кампания' },
  { key: '/panel/tasks', label: 'Дашборд задач' },
  { key: '/panel/crm', label: 'CRM · Лиды' },
  { key: '/panel/analytics', label: 'Аналитика' },
  { key: '/panel/my-statistics', label: 'Моя статистика' },
  { key: '/panel/logs', label: 'Логи' },
  { key: '/panel/inbox', label: 'Обзор аккаунта' },
  { key: '/panel/channels', label: 'Каналы (база)' },
  { key: '/panel/parsing-history', label: 'Логи парсинга' },
]

/** Типы ресурсов с индивидуальным доступом (§8.1). folders/channels — по элементам. */
export const RESOURCE_TYPES = [
  { type: 'accounts', label: 'Аккаунты (кто виден в менеджере/пикере)', perItem: true },
  { type: 'accountGroups', label: 'Группы аккаунтов (доступ сразу на группу, §12)', perItem: true },
  { type: 'folders', label: 'Папки целей', perItem: true },
  { type: 'channels', label: 'Целевые каналы', perItem: true },
  { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
  { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
  // По умолчанию человек видит в Дашборде только СВОИ запуски: чужие задачи — это
  // чужие аккаунты, цели и переписка. Это право открывает весь дашборд целиком —
  // выдаётся тимлиду или тому, кто отвечает за всю сетку.
  { type: 'allTasks', label: 'Чужие задачи (видеть и управлять всеми в Дашборде)', perItem: false },
  // Право поддержки: видеть ВСЕ тикеты пользователей и отвечать в них «как поддержка»
  // (а не как обычный юзер). Обычно выдаётся роли «Поддержка», которой больше ничего не нужно.
  { type: 'support', label: 'Поддержка (видеть все тикеты и отвечать как поддержка)', perItem: false },
]

/** Нормализовать значение доступа: всё, что не 'allow', — deny. @param {*} v */
function normPerm(v) {
  return v === ALLOW ? ALLOW : DENY
}

/** Нормализовать карту `folderId → string[]` (какие каналы/ссылки папки выданы роли).
 *  Пустой массив/отсутствие для разрешённой папки = все каналы папки. @param {*} obj */
function normFolderChannels(obj) {
  /** @type {Record<string,string[]>} */
  const out = {}
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) out[k] = [...new Set(v.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]
    }
  }
  return out
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
      // Роль «без оплаты» (тест/модератор): доступ к модулям в обход подписки.
      freeAccess: !!p.freeAccess,
      modules: normPermMap(p.modules),
      blocks: normPermMap(p.blocks), // ключ = `${moduleKey}:${blockKey}`
      sections: normPermMap(p.sections), // ключ = путь раздела (напр. '/panel/proxies')
      resources: {
        accounts: normPermMap(r.accounts), // accountId → allow/deny (кто виден роли)
        accountGroups: normPermMap(r.accountGroups), // §12: groupId → allow/deny (доступ на всю группу)
        folders: normPermMap(r.folders),
        channels: normPermMap(r.channels),
        folderChannels: normFolderChannels(r.folderChannels),
        timers: normPerm(r.timers),
        searchTemplates: normPerm(r.searchTemplates),
        allTasks: normPerm(r.allTasks),
        support: normPerm(r.support),
      },
    },
  }
}

const moduleMap = (keys, val) => Object.fromEntries(keys.map((k) => [k, val]))
const blockMap = (keys, blocks, val) => Object.fromEntries(keys.flatMap((k) => blocks.map((b) => [`${k}:${b}`, val])))
/** Карта разделов key→val. Без аргумента keys — все разделы каталога. */
const sectionMap = (val, keys = SECTIONS.map((s) => s.key)) => Object.fromEntries(keys.map((k) => [k, val]))

/**
 * Стартовый набор ролей — осмысленные шаблоны под реальные функции (не «всё подряд»).
 *  - Администратор — bypass (всё);
 *  - Оператор — универсальный исполнитель: все модули, все блоки, все разделы;
 *  - Модератор — вовлечение/модерация: комментинг/чаттинг/диалоги/реакции/масслукинг
 *    (запуск+настройки+цели+результаты+логи, БЕЗ редактирования шаблонов);
 *  - Sales — аутрич/CRM: запуск чаттинга/диалогов/мейлинга целиком + просмотр остального;
 *  - Viewer — только просмотр: результаты/логи + отчётные разделы.
 * Каждый шаблон: аккаунты по умолчанию НЕ выданы (админ раздаёт точечно).
 */
function defaultRoles() {
  const now = Date.now()
  const mods = Object.keys(MODULE_LABELS)
  const ALL_BLOCKS = BLOCKS.map((b) => b.key)                 // run/settings/targets/templates/results/logs
  const VIEW = ['results', 'logs']                             // только просмотр
  const OPS = ['run', 'settings', 'targets', 'results', 'logs'] // работа без редактирования шаблонов
  const OUTREACH = mods.filter((k) => ['neuro-chatting', 'neuro-dialogs', 'mailing'].includes(k))
  const ENGAGE = mods.filter((k) => ['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-react', 'mass-looking'].includes(k))
  const roleTpl = (id, name, permissions) => ({ id, name, builtin: false, isTemplate: true, permissions, createdAt: now, updatedAt: now })
  const res = (over = {}) => ({ accounts: {}, folders: {}, channels: {}, timers: DENY, searchTemplates: DENY, allTasks: DENY, support: DENY, ...over })
  return [
    {
      id: ADMIN_ROLE_ID,
      name: 'Администратор',
      builtin: true,
      isTemplate: false,
      permissions: { modules: {}, blocks: {}, sections: {}, resources: res({ timers: ALLOW, searchTemplates: ALLOW, allTasks: ALLOW }) },
      createdAt: now,
      updatedAt: now,
    },
    // Оператор — всё операционное: любые модули, все блоки, все разделы.
    roleTpl('role_operator', 'Оператор', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, ALL_BLOCKS, ALLOW),
      sections: sectionMap(ALLOW),
      resources: res({ timers: ALLOW, searchTemplates: ALLOW }),
    }),
    // Модератор — вовлечение сообщества: только engagement-модули, без шаблонов и без парсинга/рассылок.
    roleTpl('role_moderator', 'Модератор', {
      modules: moduleMap(ENGAGE, ALLOW),
      blocks: blockMap(ENGAGE, OPS, ALLOW),
      sections: sectionMap(ALLOW, ['/panel', '/panel/tasks', '/panel/crm', '/panel/analytics', '/panel/my-statistics', '/panel/logs', '/panel/inbox', '/panel/channels']),
      resources: res({ searchTemplates: ALLOW }),
    }),
    // Sales — аутрич/продажи: чаттинг/диалоги/мейлинг целиком, остальное — просмотр.
    roleTpl('role_sales', 'Sales', {
      modules: moduleMap(mods, ALLOW),
      blocks: { ...blockMap(mods, VIEW, ALLOW), ...blockMap(OUTREACH, ALL_BLOCKS, ALLOW) },
      sections: sectionMap(ALLOW, ['/panel', '/panel/goals', '/panel/tasks', '/panel/crm', '/panel/analytics', '/panel/my-statistics', '/panel/inbox', '/panel/logs']),
      resources: res({ searchTemplates: ALLOW }),
    }),
    // Viewer — наблюдатель: результаты/логи + отчётные разделы, без запуска и настроек.
    roleTpl('role_viewer', 'Viewer', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, VIEW, ALLOW),
      sections: sectionMap(ALLOW, ['/panel/tasks', '/panel/analytics', '/panel/my-statistics', '/panel/logs', '/panel/inbox']),
      resources: res(),
    }),
    // Поддержка — только тикеты: видит все обращения, отвечает как поддержка. Больше
    // ничего (никаких модулей/разделов, кроме «Поддержки»).
    roleTpl('role_support', 'Поддержка', {
      modules: {},
      blocks: {},
      sections: sectionMap(ALLOW, ['/panel/support']),
      resources: res({ support: ALLOW }),
    }),
  ]
}

export async function listRoles() {
  const db = sbRoles()
  if (db) {
    const { data } = await db.from('roles').select('*').order('created_at', { ascending: true })
    return (data || []).map(rowToRole)
  }
  const roles = await readJson(ROLES_FILE(), null)
  if (!Array.isArray(roles)) {
    const seed = defaultRoles()
    await writeJson(ROLES_FILE(), seed)
    return seed
  }
  // §12: у ролей, созданных до групп аккаунтов, поля нет — дошиваем пустую карту,
  // чтобы матрица прав показывала группы (иначе нечего переключать).
  for (const r of roles) {
    if (r?.permissions?.resources && !r.permissions.resources.accountGroups) {
      r.permissions.resources.accountGroups = {}
    }
  }
  // Разовая миграция старых инсталляций: если НЕТ ни одной из §6-ролей
  // (Operator/Sales/Viewer) — добавляем их, не трогая существующие/пользовательские.
  // Гейт «ни одной» защищает от воскрешения одной удалённой дефолт-роли.
  const have = new Set(roles.map((r) => r.id))
  const sixIds = ['role_operator', 'role_moderator', 'role_sales', 'role_viewer']
  if (!sixIds.some((id) => have.has(id))) {
    const missing = defaultRoles().filter((r) => r.id !== ADMIN_ROLE_ID && !have.has(r.id))
    if (missing.length) {
      const merged = [...roles, ...missing]
      await writeJson(ROLES_FILE(), merged)
      return merged
    }
  }
  // Точечная миграция: роль «Поддержка» добавлена позже — дошиваем её, если её нет
  // (остальные дефолт-роли при этом уже могут быть, поэтому отдельно от блока выше).
  if (!have.has('role_support')) {
    const supp = defaultRoles().find((r) => r.id === 'role_support')
    if (supp) { roles.push(supp); await writeJson(ROLES_FILE(), roles) }
  }
  // Миграция поля `sections` (добавлено позже). Принцип: НЕ уменьшать доступ. До появления
  // `sections` все роли видели ВСЕ разделы — значит роли без этого поля получают весь набор
  // (allow). Новые роли стартуют с deny (emptyPermissions), админ выдаёт разделы вручную.
  const allSections = sectionMap(ALLOW)
  let migrated = false
  for (const r of roles) {
    if (r.permissions && r.permissions.sections == null) {
      r.permissions.sections = { ...allSections }
      migrated = true
    }
  }
  if (migrated) await writeJson(ROLES_FILE(), roles)
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
  const db = sbRoles()
  if (db) {
    const { insertWithOwner } = await import('./lib/ownerColumn.js')
    await insertWithOwner(db, 'roles', roleToRow(role))
    return role
  }
  roles.push(role)
  await writeJson(ROLES_FILE(), roles)
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
  const db = sbRoles()
  if (db) {
    // §11.3: updateWithOwner — до применения миграции колонки user_id нет, и обычный
    // update уронил бы правку роли целиком. Владелец при этом сохраняется: rowToRole
    // читает его из БД, roleToRow кладёт обратно.
    const { updateWithOwner } = await import('./lib/ownerColumn.js')
    await updateWithOwner(db, 'roles', roleToRow(roles[i]), 'id', id)
    return roles[i]
  }
  await writeJson(ROLES_FILE(), roles)
  return roles[i]
}

/** Удалить роль (кроме встроенных). @param {string} id */
export async function deleteRole(id) {
  const roles = await listRoles()
  const target = roles.find((r) => r.id === id)
  if (!target) return false
  if (target.builtin) throw new Error('Встроенную роль удалить нельзя')
  const db = sbRoles()
  if (db) { await db.from('roles').delete().eq('id', id); return true }
  const next = roles.filter((r) => r.id !== id)
  await writeJson(ROLES_FILE(), next)
  return true
}

/**
 * Каталог того, что можно раздавать: модули × блоки + ресурсы (с реальными элементами).
 * Фронт рендерит матрицу прав из этого каталога.
 */
export async function buildCatalog() {
  const modules = Object.entries(MODULE_LABELS).map(([key, label]) => ({ key, label }))
  const [folders, channels, meta, groups] = await Promise.all([listFolders(), listChannels(), loadAllMeta(), listGroups()])
  // Аккаунты для выдачи доступа (лёгкий список из метаданных — без подключения к Telegram).
  const accountItems = Object.entries(meta)
    .filter(([, m]) => m && !m.inTrash)
    .map(([id, m]) => ({ id, label: m.name || (m.username ? '@' + m.username : id) }))
  const resources = [
    { type: 'accounts', label: 'Аккаунты (кто виден роли)', perItem: true, items: accountItems },
    // §12: доступ сразу на группу — удобнее, чем отмечать аккаунты по одному.
    { type: 'accountGroups', label: 'Группы аккаунтов (доступ на всю группу)', perItem: true, items: groups.map((g) => ({ id: g.id, label: `${g.name} · ${(g.accountIds || []).length} акк.` })) },
    { type: 'folders', label: 'Папки целей', perItem: true, items: folders.map((f) => ({ id: f.id, label: f.name || f.id, channels: f.targets || [] })) },
    { type: 'channels', label: 'Целевые каналы', perItem: true, items: channels.map((c) => ({ id: c.id, label: c.title || (c.username ? '@' + c.username : c.id) })) },
    { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
    { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
    { type: 'allTasks', label: 'Чужие задачи (видеть и управлять всеми в Дашборде)', perItem: false },
  ]
  return { modules, blocks: BLOCKS, sections: SECTIONS, resources }
}

/**
 * Разрешён ли доступ роли к цели. Чистая функция (юнит-тест + будущий enforcement).
 * Админ (builtin ADMIN_ROLE_ID) — всегда true. По умолчанию — deny.
 * @param {object|null} role
 * @param {'module'|'block'|'section'|'account'|'accountGroup'|'folder'|'channel'|'timers'|'searchTemplates'|'allTasks'} kind
 * @param {string} [key]
 */
export function can(role, kind, key) {
  if (!role) return false
  if (role.builtin && role.id === ADMIN_ROLE_ID) return true
  const p = role.permissions || {}
  switch (kind) {
    case 'module': return p.modules?.[key] === ALLOW
    case 'block': return p.blocks?.[key] === ALLOW
    case 'section': return p.sections?.[key] === ALLOW
    case 'account': return p.resources?.accounts?.[key] === ALLOW
    case 'accountGroup': return p.resources?.accountGroups?.[key] === ALLOW // §12
    case 'folder': return p.resources?.folders?.[key] === ALLOW
    case 'channel': return p.resources?.channels?.[key] === ALLOW
    case 'timers': return p.resources?.timers === ALLOW
    case 'searchTemplates': return p.resources?.searchTemplates === ALLOW
    case 'allTasks': return p.resources?.allTasks === ALLOW
    default: return false
  }
}

const normTarget = (t) => String(t || '').trim().replace(/^@/, '').toLowerCase()

/**
 * Какие каналы папки видит роль. Админ — все. Папка не разрешена — []. Разрешена без
 * списка каналов — все каналы папки. Со списком — только выбранные (пересечение).
 * @param {object|null} role @param {string} folderId @param {string[]} folderTargets
 * @returns {string[]}
 */
export function allowedFolderTargets(role, folderId, folderTargets = []) {
  if (!role) return folderTargets
  if (role.builtin && role.id === ADMIN_ROLE_ID) return folderTargets
  const folders = role.permissions?.resources?.folders || {}
  if (Object.keys(folders).length === 0) return folderTargets // права папок не заданы — не ограничиваем
  if (folders[folderId] !== ALLOW) return []
  const fc = role.permissions?.resources?.folderChannels?.[folderId]
  if (!Array.isArray(fc) || fc.length === 0) return folderTargets
  const allow = new Set(fc.map(normTarget))
  return folderTargets.filter((t) => allow.has(normTarget(t)))
}

/** Список ролей пользователя (мульти-роль). Совместимо со старым одиночным roleId. @param {object|null} user */
export function userRoleIds(user) {
  if (!user) return []
  const raw = Array.isArray(user.roleIds) ? user.roleIds : (user.roleId != null ? [user.roleId] : [])
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
}

/** Есть ли у набора ролей админ (bypass). @param {string[]} ids */
export function hasAdminRole(ids = []) {
  return ids.includes(ADMIN_ROLE_ID)
}

/** Есть ли у роли право «Поддержка» (видеть все тикеты и отвечать как поддержка). @param {object[]} roles */
export function hasSupportCap(roles = []) {
  return (roles || []).some((r) => r?.permissions?.resources?.support === ALLOW)
}

/** Загрузить объекты ролей пользователя. @param {object|null} user @returns {Promise<object[]>} */
export async function rolesForUser(user) {
  const out = []
  for (const id of userRoleIds(user)) {
    const r = await getRole(id)
    if (r) out.push(r)
  }
  return out
}

/**
 * Объединить права нескольких ролей (union — «суммирование»): доступ allow, если его даёт
 * хотя бы одна роль. Каналы внутри папки складываются; если хоть одна роль дала папку без
 * ограничения по каналам (пустой список) — ограничение снимается (= все каналы). §8.1.
 * @param {object[]} roles @returns {RolePermissions}
 */
/**
 * Слить одно поэлементное право в общую карту. Семантика — «запрет сильнее»:
 * если хоть одна роль явно запретила элемент, объединение остаётся запретом,
 * сколько бы других ролей его ни разрешало. Иначе точечный запрет невозможно
 * было бы задать поверх группового доступа — ради чего он и существует.
 * @param {Record<string,string>} map @param {string} key @param {string} value
 */
function mergeItem(map, key, value) {
  if (map[key] === DENY) return // уже запрещено — allow не перебивает
  map[key] = value
}

export function mergePermissions(roles = []) {
  const resources = { accounts: {}, accountGroups: {}, folders: {}, channels: {}, folderChannels: {}, timers: DENY, searchTemplates: DENY, allTasks: DENY }
  const merged = { modules: {}, blocks: {}, sections: {}, resources }
  const wholeFolder = new Set() // папки, где хоть одна роль дала «все каналы»
  for (const role of roles) {
    const p = role?.permissions
    if (!p) continue
    const r = p.resources || {}
    for (const [k, v] of Object.entries(p.modules || {})) if (v === ALLOW) merged.modules[k] = ALLOW
    for (const [k, v] of Object.entries(p.blocks || {})) if (v === ALLOW) merged.blocks[k] = ALLOW
    for (const [k, v] of Object.entries(p.sections || {})) if (v === ALLOW) merged.sections[k] = ALLOW
    // §8.1: поэлементные ресурсы копируем ВМЕСТЕ С ЗАПРЕТАМИ. Раньше сюда проходил
    // только ALLOW, поэтому явный точечный deny терялся при объединении ролей и до
    // клиента не доезжал никогда — точечный запрет не работал в принципе
    // (прогон 21–22.07, тест 7.4). Приоритет разрешается ниже: deny сильнее allow.
    for (const [k, v] of Object.entries(r.accounts || {})) if (v === ALLOW || v === DENY) mergeItem(resources.accounts, k, v)
    for (const [k, v] of Object.entries(r.accountGroups || {})) if (v === ALLOW || v === DENY) mergeItem(resources.accountGroups, k, v) // §12
    for (const [k, v] of Object.entries(r.channels || {})) if (v === ALLOW || v === DENY) mergeItem(resources.channels, k, v)
    if (r.timers === ALLOW) resources.timers = ALLOW
    if (r.searchTemplates === ALLOW) resources.searchTemplates = ALLOW
    // Без этой строки право «чужие задачи» терялось при объединении ролей: сервер
    // читает роли напрямую и работал верно, а фронт получал права БЕЗ него и
    // молча отказывал — расхождение, которое видно только в интерфейсе.
    if (r.allTasks === ALLOW) resources.allTasks = ALLOW
    const fc = r.folderChannels || {}
    for (const [folderId, v] of Object.entries(r.folders || {})) {
      // Запрет на папку тоже должен доживать до клиента и побеждать разрешение другой
      // роли — иначе точечный запрет работает для аккаунтов и каналов, но молча
      // не работает для папок (найдено аудитом собственных правок 22.07, ср. тест 7.4).
      if (v === DENY) { mergeItem(resources.folders, folderId, DENY); continue }
      if (v !== ALLOW) continue
      if (resources.folders[folderId] === DENY) continue // запрет уже поставлен — allow не перебивает
      resources.folders[folderId] = ALLOW
      const list = fc[folderId]
      if (!Array.isArray(list) || list.length === 0) {
        wholeFolder.add(folderId)
      } else {
        const cur = resources.folderChannels[folderId] || []
        resources.folderChannels[folderId] = [...new Set([...cur, ...list.map(normTarget)])]
      }
    }
  }
  for (const folderId of wholeFolder) delete resources.folderChannels[folderId] // «вся папка» побеждает
  return merged
}
