/**
 * Реестр возможностей платформы — «что тут вообще есть и что из этого МНЕ разрешено».
 *
 * Раньше на этот вопрос отвечал один эндпоинт `/api/v1/capabilities`, и отвечал только
 * про модули. Оркестратору этого мало: модуль — не единственное, чем он оперирует.
 * Прокси, менеджер аккаунтов, дашборд задач и статистика — это отдельные подсистемы со
 * своими правами и своими эндпоинтами, и не зная о них, «мозги» строят план, который
 * упирается в 403 на первом же шаге.
 *
 * Три ВИДА возможностей:
 *   • `module`  — кампанийный модуль (нейрокомментинг, мейлинг, парсеры…). Делает
 *                 действия в Telegram, имеет схему задачи, стоит денег за действие.
 *   • `service` — подсистема платформы, не являющаяся модулем: прокси, аккаунты, задачи,
 *                 статистика, цели, кампании, CRM, логи. Права выдаются разделом (§8.1).
 *   • `user`    — сам носитель прав: роли, что ему разрешено, лимиты, баланс.
 *
 * Права считаются ТЕМ ЖЕ кодом, что и вход в панель (`lib/effectivePermissions.js`).
 * Второй реализации «что человеку можно» тут быть не должно: разойдётся — и панель
 * покажет одно, а API ответит другое.
 */
import { MODULE_DEFS, listModuleKeys } from '../modules/registry.js'
import { SECTIONS, BLOCKS, ALLOW } from '../roles.js'
import { getDescriptor, summarizeModule } from './descriptors/index.js'

/** Виды возможностей. Порядок = порядок в ответе «всё сразу». */
export const CAPABILITY_KINDS = ['module', 'service', 'user']

/** Множественная форма вида — она же сегмент пути REST. */
export const KIND_PLURAL = { module: 'modules', service: 'services', user: 'users' }
export const KIND_BY_PLURAL = { modules: 'module', services: 'service', users: 'user' }

/**
 * Каталог сервисов — подсистем платформы, которые не являются модулями.
 *
 * Опорой взят `SECTIONS` из `roles.js`: это уже существующий список областей платформы,
 * и он уже привязан к правам. Выдумывать рядом второй список «что у нас есть» нельзя —
 * он немедленно разойдётся с тем, по которому реально выдаётся доступ.
 *
 * `section: null` — подсистема без отдельного раздела в меню (баланс доступен всем).
 */
export const SERVICES = [
  {
    key: 'accounts',
    title: 'Account manager',
    section: '/panel',
    summary: 'The pool of managed Telegram accounts: statuses, proxies, groups, authorisation and daily limits.',
    does: [
      'lists the accounts this user may see, with status, trust score and daily action counters',
      'authorises accounts by phone (code, 2FA) and re-authorises the ones that dropped',
      'shows which task currently holds an account and lets it be released',
      'groups accounts so access can be granted to a whole group at once',
    ],
    doesNot: [
      'does not perform Telegram actions itself — that is what modules do',
      'does not buy or register accounts; import is a separate flow',
    ],
    endpoints: [
      { method: 'GET', path: '/api/tg/accounts', title: 'Accounts visible to the caller' },
      { method: 'GET', path: '/api/tg/accounts/busy', title: 'Which accounts are held by a running task' },
      { method: 'GET', path: '/api/tg/accounts/:accountId/stats', title: 'Trust score, health and history' },
      { method: 'GET', path: '/api/tg/accounts/:accountId/daily', title: 'Daily action counters against the safety limits' },
      { method: 'POST', path: '/api/tg/accounts/:accountId/release', title: 'Release an account stuck on a dead task' },
      { method: 'GET', path: '/api/account-groups', title: 'Account groups' },
    ],
    resources: ['accounts', 'accountGroups'],
    relatedModules: 'all',
    notes: 'Every module task names accounts by id; an account that is unavailable to the key owner is refused with 403, and an account already busy with another task is refused by the launch rules.',
  },
  {
    key: 'proxies',
    title: 'Proxies',
    section: '/panel/proxies',
    summary: 'Proxy pool bound to accounts: without a working proxy an account is not allowed to act.',
    does: [
      'stores the proxy pool and which account uses which proxy',
      'checks proxies for reachability, one by one or all at once',
      'imports proxies in bulk from text',
      'exposes shared proxies that several accounts may sit behind',
    ],
    doesNot: [
      'does not buy proxies and does not rotate them automatically',
      'does not fix an account whose proxy died — the account simply stops being runnable',
    ],
    endpoints: [
      { method: 'GET', path: '/api/proxies', title: 'Proxy pool' },
      { method: 'GET', path: '/api/proxies/shared', title: 'Shared proxies' },
      { method: 'POST', path: '/api/proxies/:id/check', title: 'Check one proxy' },
      { method: 'POST', path: '/api/proxies/check-all', title: 'Check the whole pool' },
      { method: 'POST', path: '/api/proxies/import', title: 'Bulk import' },
    ],
    resources: [],
    relatedModules: 'all',
    notes: 'A dead proxy is one of the two most common reasons a task does nothing at all — the other is account status. Check here before blaming a module.',
  },
  {
    key: 'tasks',
    title: 'Tasks dashboard',
    section: '/panel/tasks',
    summary: 'Every task of every module in one place: status, progress, logs, stop, pause and restart.',
    does: [
      'lists tasks across all modules, newest first',
      'shows progress against the task\'s real target and the tail of its log',
      'stops, pauses, resumes and restarts a task',
      'edits the settings of a running task where the module allows it',
    ],
    doesNot: [
      'does not create tasks — a task is created by its module',
      'does not undo actions already performed in Telegram; nothing can',
    ],
    endpoints: [
      { method: 'GET', path: '/api/modules/tasks', title: 'All tasks across modules' },
      { method: 'GET', path: '/api/modules/:moduleKey/tasks', title: 'Tasks of one module' },
      { method: 'GET', path: '/api/modules/:moduleKey/tasks/:id', title: 'One task with logs' },
      { method: 'POST', path: '/api/modules/:moduleKey/tasks/:id/stop', title: 'Stop' },
      { method: 'POST', path: '/api/modules/:moduleKey/tasks/:id/pause', title: 'Pause' },
      { method: 'POST', path: '/api/modules/:moduleKey/tasks/:id/resume', title: 'Resume' },
    ],
    resources: ['allTasks'],
    relatedModules: 'all',
    notes: 'By default a user sees only their OWN tasks. The allTasks resource permission opens the whole dashboard and is normally given to a team lead. Over MCP use get_task and stop_task instead of these routes.',
  },
  {
    key: 'analytics',
    title: 'Analytics',
    section: '/panel/analytics',
    summary: 'Cross-account, cross-module reporting: what was done, at what cost, with what result.',
    does: [
      'aggregates actions by module, account and day',
      'reports spend and token consumption against campaigns',
      'surfaces problem accounts and health of the pool',
    ],
    doesNot: [
      'does not show another user\'s data unless the role grants it',
      'does not replace per-task logs — for one run use the tasks dashboard',
    ],
    endpoints: [
      { method: 'GET', path: '/api/admin/overview', title: 'Overview' },
      { method: 'GET', path: '/api/admin/daily', title: 'Daily aggregates' },
      { method: 'GET', path: '/api/admin/accounts-health', title: 'Account pool health' },
      { method: 'GET', path: '/api/admin/problems', title: 'Problem accounts and tasks' },
    ],
    resources: [],
    relatedModules: 'all',
    notes: 'Platform-wide numbers. For a single operator\'s own figures use the my-statistics service, which is gated separately.',
  },
  {
    key: 'my-statistics',
    title: 'Own statistics',
    section: '/panel/my-statistics',
    summary: 'The figures for the current user alone: their runs, their spend, their results.',
    does: [
      'shows the caller\'s own actions and spend over a period',
      'shows their work log',
    ],
    doesNot: ['does not show anyone else\'s figures — that is the analytics service'],
    endpoints: [
      { method: 'GET', path: '/api/accounts/:accountId/work', title: 'Work log for an account' },
      { method: 'GET', path: '/api/accounts/:accountId/actions', title: 'Action log for an account' },
    ],
    resources: [],
    relatedModules: 'all',
    notes: 'Gated by a separate section from analytics: an operator normally has this and not analytics.',
  },
  {
    key: 'goals',
    title: 'Goals',
    section: '/panel/goals',
    summary: 'The measurable result a campaign works towards; supplies context and a knowledge base to AI generation.',
    does: [
      'stores goals with a metric, a target value and a deadline',
      'feeds goal context and knowledge base into text generation',
      'tracks progress towards the target',
      'holds the knowledge-base files attached to a goal',
    ],
    doesNot: [
      'does not run anything by itself — a goal is referenced by a task via goalId',
      'does not define tone or persona; that belongs to the agent',
    ],
    endpoints: [
      { method: 'GET', path: '/api/v1/goals', title: 'List goals (MCP key)' },
      { method: 'POST', path: '/api/v1/goals', title: 'Create a goal (MCP key)' },
      { method: 'GET', path: '/api/goals/:id/progress', title: 'Progress towards the target' },
      { method: 'GET', path: '/api/goals/:goalId/kb', title: 'Knowledge base of a goal' },
    ],
    resources: [],
    relatedModules: ['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mailing'],
    notes: 'An expired goal stops a running task and blocks a new one. Several module fields only take effect when goalId is set — semanticFilter is the usual one.',
  },
  {
    key: 'campaigns',
    title: 'Campaigns',
    section: '/panel/campaign',
    summary: 'Groups tasks under one goal for reporting, billing attribution and scheduling.',
    does: [
      'groups module tasks under a shared goal',
      'attributes token spend and results to the campaign',
      'schedules launches',
    ],
    doesNot: ['does not change how a module behaves — it is an accounting and scheduling layer'],
    endpoints: [
      { method: 'GET', path: '/api/v1/campaigns', title: 'List campaigns (MCP key)' },
      { method: 'POST', path: '/api/v1/campaigns', title: 'Create a campaign (MCP key)' },
      { method: 'GET', path: '/api/campaigns/schedules', title: 'Scheduled launches' },
      { method: 'POST', path: '/api/campaigns/launch', title: 'Launch a campaign' },
    ],
    resources: ['timers'],
    relatedModules: 'all',
    notes: 'campaignId on a task is optional and affects reporting only, never behaviour.',
  },
  {
    key: 'crm',
    title: 'CRM and leads',
    section: '/panel/crm',
    summary: 'People the campaigns produced: lead records, their stage, and the conversation behind each one.',
    does: [
      'stores leads with a stage, source and the account that produced them',
      'keeps the conversation history for a lead',
      'classifies replies into stages automatically',
    ],
    doesNot: ['does not send messages — that is neuro-dialogs and mailing'],
    endpoints: [
      { method: 'GET', path: '/api/leads', title: 'Leads' },
      { method: 'GET', path: '/api/leads/stats', title: 'Funnel figures' },
      { method: 'GET', path: '/api/leads/:id/conversation', title: 'Conversation behind a lead' },
    ],
    resources: [],
    relatedModules: ['neuro-dialogs', 'mailing', 'neuro-chatting'],
    notes: 'Leads appear as a side effect of dialog modules; they are not created by hand in normal operation.',
  },
  {
    key: 'channels',
    title: 'Channel database',
    section: '/panel/channels',
    summary: 'The stored catalogue of channels and groups the parsers found, reusable as targets.',
    does: [
      'stores channels and groups with their metadata',
      'refreshes a channel\'s figures on demand',
      'organises targets into folders that roles can be granted per item',
    ],
    doesNot: ['does not parse — the parsing modules fill this database'],
    endpoints: [
      { method: 'GET', path: '/api/channels', title: 'Channel database' },
      { method: 'POST', path: '/api/channels/:id/refresh', title: 'Refresh one channel' },
      { method: 'GET', path: '/api/target-folders', title: 'Target folders' },
      { method: 'GET', path: '/api/target-blacklist', title: 'Blacklist applied before every action' },
    ],
    resources: ['channels', 'folders'],
    relatedModules: ['parsing', 'parsing-groups', 'parsing-users', 'parsing-messages', 'parsing-comments'],
    notes: 'The blacklist is enforced before any action in every module, including mailing recipients.',
  },
  {
    key: 'logs',
    title: 'Logs',
    section: '/panel/logs',
    summary: 'The audit trail: who launched what, what each account did, and why an action was skipped.',
    does: [
      'records every task action with its outcome and reason',
      'records administrative changes for audit',
    ],
    doesNot: ['does not keep message bodies beyond what the conversation history stores'],
    endpoints: [
      { method: 'GET', path: '/api/admin/task-logs', title: 'Task logs across modules' },
      { method: 'GET', path: '/api/accounts/:accountId/actions', title: 'Action log for one account' },
    ],
    resources: [],
    relatedModules: 'all',
    notes: 'Every skipped action is logged with its reason. A near-zero result is almost always a filter doing its job, and it says so here.',
  },
  {
    key: 'automation',
    title: 'Automation',
    section: '/panel/automation',
    summary: 'Rules that launch or stop work without an operator: triggers, schedules and reactions to state.',
    does: ['stores automation rules', 'runs a rule on demand or on its schedule'],
    doesNot: ['does not replace campaign scheduling; it reacts to state rather than to a calendar alone'],
    endpoints: [
      { method: 'GET', path: '/api/automation/rules', title: 'Rules' },
      { method: 'POST', path: '/api/automation/rules/:id/run', title: 'Run a rule now' },
    ],
    resources: ['timers'],
    relatedModules: 'all',
    notes: 'A task created by a rule is an ordinary task and appears in the dashboard like any other.',
  },
  {
    key: 'billing',
    title: 'Balance and billing',
    section: null,
    summary: 'What a run will cost and whether there is enough balance to pay for it.',
    does: [
      'reports the current balance and which modules are paid for',
      'reports the price of an action per module and the token rate',
      'keeps the spend history',
    ],
    doesNot: ['does not block a task by itself — an unaffordable run fails at the action, not at creation'],
    endpoints: [
      { method: 'GET', path: '/api/balance', title: 'Balance and paid modules' },
      { method: 'GET', path: '/api/balance/history', title: 'Spend history' },
      { method: 'POST', path: '/api/v1/modules/:key/estimate', title: 'Estimate a run before launching it' },
    ],
    resources: [],
    relatedModules: 'all',
    notes: 'Available to everyone: it has no section gate. Over MCP use estimate_task, which reads the same prices.',
  },
]

const SERVICE_BY_KEY = new Map(SERVICES.map((s) => [s.key, s]))

// ── Кто спрашивает ─────────────────────────────────────────────────────────────

/**
 * Разобрать личность запрашивающего.
 *
 * Сервисный env-ключ без владельца — это не пользователь, а сама система: у него полный
 * доступ, и `permissions` для него не считается вовсе.
 *
 * @param {{req?: object}} ctx
 * @returns {Promise<{userId: string, isService: boolean, isAdmin: boolean, user: object|null,
 *   permissions: object|null, roles: object[], roleName: string, unrestricted: boolean}>}
 */
export async function resolveViewer(ctx = {}) {
  const apiKey = ctx.req?.apiKey || null
  const userId = apiKey?.ownerId || ''
  if (!userId) {
    return {
      userId: 'system',
      isService: true,
      isAdmin: true,
      user: null,
      permissions: null,
      roles: [],
      roleName: 'Service key (env)',
      unrestricted: true,
    }
  }
  const { getUser } = await import('../users.js')
  const user = await getUser(userId).catch(() => null)
  if (!user) {
    // Ключ ссылается на удалённого пользователя. Молча выдавать полный доступ нельзя:
    // это ровно та ситуация, в которой отозванный сотрудник продолжает работать ключом.
    return { userId, isService: false, isAdmin: false, user: null, permissions: {}, roles: [], roleName: '', unrestricted: false }
  }
  const { resolveUserAccess } = await import('../lib/effectivePermissions.js')
  const acc = await resolveUserAccess(user)
  return {
    userId,
    isService: false,
    isAdmin: acc.isAdmin,
    user,
    permissions: acc.permissions,
    roles: acc.roles,
    roleName: acc.roleName,
    // `permissions === null` означает «правами не ограничен» (админ) — см. lib/effectivePermissions.js.
    unrestricted: acc.isAdmin || acc.permissions === null,
  }
}

/** Может ли смотрящий видеть возможности ЧУЖОГО пользователя. */
export const canViewOtherUsers = (viewer) => viewer.isService || viewer.isAdmin

const allowed = (viewer, map, key) => (viewer.unrestricted ? true : map?.[key] === ALLOW)

// ── Модули ─────────────────────────────────────────────────────────────────────

/**
 * Возможность-модуль: что он умеет, сколько стоит и разрешён ли он смотрящему.
 * @param {string} key ключ модуля
 * @param {object} viewer из resolveViewer
 * @param {{prices: object}} deps предзагруженные цены (чтобы не читать их на каждый модуль)
 */
function buildModuleCapability(key, viewer, deps) {
  const def = MODULE_DEFS[key]
  if (!def) return null
  const desc = getDescriptor(key)
  const summary = summarizeModule(key)
  const price = deps.prices.modules.find((m) => m.key === key) || { month: 0, action: 0 }

  // Блоки внутри модуля: право выдаётся на «модуль:блок» (`neuro-chatting:run`).
  const blocks = {}
  for (const b of BLOCKS) blocks[b.key] = allowed(viewer, viewer.permissions?.blocks, `${key}:${b.key}`)

  // Тратит ли модуль токены модели. Источник правды — дескриптор: его же читает
  // `priceStore.js`, чтобы решить, начислять ли месячный пакет токенов.
  const usesAi = desc?.usesAi === true

  return {
    kind: 'module',
    key,
    // Название берём из ДЕСКРИПТОРА: `moduleTitle()` — это витринная подпись для панели,
    // и она русская. По правилу раздела всё, что уезжает «мозгам», английское, поэтому
    // здесь может стоять только английский заголовок дескриптора; у неописанного модуля
    // честнее показать ключ, чем русскую подпись.
    title: desc?.title || key,
    summary: desc?.whoAmI?.summary || null,
    usesAi,
    tags: desc?.tags || [],
    // Главное поле для оркестратора: можно ли доверять этому описанию как полному.
    schema: desc ? 'full' : 'partial',
    schemaVersion: desc?.version ?? null,
    paramCount: summary?.paramCount ?? null,
    requiresTargets: !!def.requiresTargets,
    // Английская подпись цели: `targetLabel` в MODULE_DEFS русская, она для панели.
    targetLabel: def.targetLabelEn || null,
    // `coinsPer1kTokens` отсюда убран: курс «токен → монета» из админки признан
    // выдуманным значением и удалён из модели цен (созвон 19.08). Оставить поле значило
    // бы обещать «мозгам» величину, которой в системе больше нет, — а именно от таких
    // обещаний весь этот раздел и лечится.
    pricing: {
      subscriptionPerMonth: price.month,
      perAction: deps.prices.actionMap[key] ?? price.action ?? 0,
      monthlyTokens: price.monthlyTokens ?? 0,
      currency: 'USD',
      // Расход на ИИ считается по факту и только у ИИ-модулей: у остальных генерации нет.
      ...(usesAi
        ? {
          tokenUsd: deps.prices.tokenUsd ?? null,
          tokenUsdModel: deps.prices.tokenUsdModel ?? null,
          imageMultiplier: deps.prices.imageMultiplier ?? null,
        }
        : {}),
    },
    access: {
      allowed: allowed(viewer, viewer.permissions?.modules, key),
      blocks,
      reason: viewer.unrestricted
        ? 'unrestricted: admin or service key'
        : allowed(viewer, viewer.permissions?.modules, key)
          ? 'granted by role or subscription'
          : 'not granted to this user: the role does not allow it, or the module is not paid for',
    },
    describe: desc
      ? { tool: 'describe_module', resource: `murmex://module/${key}`, rest: `/api/v1/modules/${key}/describe` }
      : null,
    run: { tool: 'create_task', rest: { method: 'POST', path: `/api/v1/modules/${key}/run` } },
  }
}

export async function listModuleCapabilities(ctx = {}, viewer) {
  const v = viewer || await resolveViewer(ctx)
  const { effectivePrices } = await import('../priceStore.js')
  const deps = { prices: await effectivePrices() }
  return listModuleKeys().map((key) => buildModuleCapability(key, v, deps)).filter(Boolean)
}

export async function getModuleCapability(key, ctx = {}, viewer) {
  if (!MODULE_DEFS[key]) return null
  const v = viewer || await resolveViewer(ctx)
  const { effectivePrices } = await import('../priceStore.js')
  return buildModuleCapability(key, v, { prices: await effectivePrices() })
}

// ── Сервисы ────────────────────────────────────────────────────────────────────

function buildServiceCapability(svc, viewer) {
  // Подсистема без раздела (баланс) доступна всем: гейта у неё нет по устройству.
  const isAllowed = svc.section === null ? true : allowed(viewer, viewer.permissions?.sections, svc.section)
  return {
    kind: 'service',
    key: svc.key,
    title: svc.title,
    summary: svc.summary,
    section: svc.section,
    // Русскую подпись раздела наружу не отдаём — она из навигации панели. Клиенту
    // нужен ключ раздела (`section`), по которому право и выдаётся.
    does: svc.does,
    doesNot: svc.doesNot,
    endpoints: svc.endpoints,
    resourcePermissions: svc.resources,
    relatedModules: svc.relatedModules,
    notes: svc.notes,
    access: {
      allowed: isAllowed,
      reason: svc.section === null
        ? 'no section gate: available to everyone'
        : viewer.unrestricted
          ? 'unrestricted: admin or service key'
          : isAllowed
            ? `granted by role via section ${svc.section}`
            : `not granted: the role does not allow section ${svc.section}`,
    },
  }
}

export async function listServiceCapabilities(ctx = {}, viewer) {
  const v = viewer || await resolveViewer(ctx)
  return SERVICES.map((s) => buildServiceCapability(s, v))
}

export async function getServiceCapability(key, ctx = {}, viewer) {
  const svc = SERVICE_BY_KEY.get(key)
  if (!svc) return null
  const v = viewer || await resolveViewer(ctx)
  return buildServiceCapability(svc, v)
}

export const listServiceKeys = () => SERVICES.map((s) => s.key)

// ── Пользователи ───────────────────────────────────────────────────────────────

/**
 * Возможность-пользователь: кто он, что ему разрешено и чем он ограничен.
 *
 * Персональные данные держим в минимуме: имя, почта и роли нужны, чтобы оркестратор
 * понимал, от чьего имени работает; всё остальное к «что мне можно» отношения не имеет.
 */
async function buildUserCapability(user, access) {
  const modules = {}
  for (const key of listModuleKeys()) {
    modules[key] = access.permissions === null ? true : access.permissions?.modules?.[key] === ALLOW
  }
  const sections = {}
  for (const s of SECTIONS) {
    sections[s.key] = access.permissions === null ? true : access.permissions?.sections?.[s.key] === ALLOW
  }
  const services = {}
  for (const svc of SERVICES) {
    services[svc.key] = svc.section === null ? true : sections[svc.section] === true
  }

  const balance = await (async () => {
    try {
      const { getBalance } = await import('../balance.js')
      const b = await getBalance(user.id)
      if (!b) return null
      return { coins: b.coins ?? null, modules: b.modules ?? null, currency: b.currency || '$' }
    } catch { return null }
  })()

  const res = access.permissions?.resources || {}
  return {
    kind: 'user',
    key: user.id,
    id: user.id,
    title: user.name || user.email || user.id,
    email: user.email || null,
    active: user.active !== false,
    isAdmin: access.isAdmin,
    isSub: !!user.parentId,
    parentId: user.parentId || null,
    roleName: access.roleName,
    roles: (access.roles || []).map((r) => ({ id: r.id, name: r.name })),
    // `null` в правах означает «ничем не ограничен» — говорим это словом, а не null'ом,
    // иначе читающий решит, что прав нет вовсе. Ровно на этой путанице один раз
    // уже сломалось меню (правка 18.08).
    unrestricted: access.permissions === null,
    access: { modules, sections, services },
    resourcePermissions: {
      allTasks: res.allTasks === ALLOW || access.permissions === null,
      timers: res.timers === ALLOW || access.permissions === null,
      searchTemplates: res.searchTemplates === ALLOW || access.permissions === null,
      support: res.support === ALLOW || access.permissions === null,
      accounts: access.permissions === null ? 'all' : Object.keys(res.accounts || {}).length ? res.accounts : 'unrestricted',
    },
    balance,
  }
}

/**
 * Возможности одного пользователя.
 * @param {string} id `me` или id пользователя
 * @returns {Promise<{capability: object}|{error: string, status: number}>}
 */
export async function getUserCapability(id, ctx = {}, viewer) {
  const v = viewer || await resolveViewer(ctx)
  const wanted = !id || id === 'me' || id === v.userId ? v.userId : String(id)

  if (wanted !== v.userId && !canViewOtherUsers(v)) {
    return {
      error: `This key acts as user "${v.userId}" and may only read its own capabilities.`
        + ' Reading another user requires an admin-role owner or the service key.',
      status: 403,
    }
  }

  // Сервисный ключ без владельца — не пользователь. Отдаём его как отдельную личность,
  // а не выдумываем запись в БД: у него нет ни ролей, ни баланса.
  if (wanted === 'system') {
    return {
      capability: {
        kind: 'user', key: 'system', id: 'system', title: 'Service key (env)', email: null,
        active: true, isAdmin: true, isSub: false, parentId: null,
        roleName: 'Service key (env)', roles: [], unrestricted: true,
        access: {
          modules: Object.fromEntries(listModuleKeys().map((k) => [k, true])),
          sections: Object.fromEntries(SECTIONS.map((s) => [s.key, true])),
          services: Object.fromEntries(SERVICES.map((s) => [s.key, true])),
        },
        resourcePermissions: { allTasks: true, timers: true, searchTemplates: true, support: true, accounts: 'all' },
        balance: null,
      },
    }
  }

  const { getUser } = await import('../users.js')
  const user = await getUser(wanted).catch(() => null)
  if (!user) return { error: `User "${wanted}" not found.`, status: 404 }

  const { resolveUserAccess } = await import('../lib/effectivePermissions.js')
  return { capability: await buildUserCapability(user, await resolveUserAccess(user)) }
}

/**
 * Возможности пользователей. Ключ, привязанный к пользователю, видит только себя;
 * админский и сервисный — всех (§8.1: владелец видит своих субов, админ — всех).
 */
export async function listUserCapabilities(ctx = {}, viewer) {
  const v = viewer || await resolveViewer(ctx)
  if (!canViewOtherUsers(v)) {
    const own = await getUserCapability(v.userId, ctx, v)
    return own.capability ? [own.capability] : []
  }
  const { listUsers } = await import('../users.js')
  const users = await listUsers().catch(() => [])
  const out = []
  for (const u of users) {
    const one = await getUserCapability(u.id, ctx, v)
    if (one.capability) out.push(one.capability)
  }
  return out
}

// ── Всё сразу ──────────────────────────────────────────────────────────────────

/**
 * Все возможности одним ответом.
 *
 * Пользователей здесь ОДИН — тот, от чьего имени работает ключ. Список всех
 * пользователей платформы в ответе «что я умею» не нужен и был бы утечкой по
 * умолчанию; за списком идут отдельным запросом.
 */
export async function allCapabilities(ctx = {}) {
  const viewer = await resolveViewer(ctx)
  const [modules, services, user] = await Promise.all([
    listModuleCapabilities(ctx, viewer),
    listServiceCapabilities(ctx, viewer),
    getUserCapability('me', ctx, viewer).then((r) => r.capability || null),
  ])
  return {
    viewer: { id: viewer.userId, isService: viewer.isService, isAdmin: viewer.isAdmin, roleName: viewer.roleName },
    counts: {
      modules: modules.length,
      modulesAllowed: modules.filter((m) => m.access.allowed).length,
      services: services.length,
      servicesAllowed: services.filter((s) => s.access.allowed).length,
    },
    modules,
    services,
    user,
    note: 'access.allowed is computed for the key owner. A capability with allowed: false will refuse with 403 — plan around it rather than retrying.',
  }
}
