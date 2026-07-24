/**
 * SPEC §5.3 (E1/E2): сводная статистика для админ-панели и постатейный отчёт клиенту.
 *
 * Данные уже есть по системе — журнал токенов (C1), аудит (§3.1), задачи модулей,
 * аккаунты, баланс. Здесь они сводятся в один ответ, чтобы админка не собирала
 * картину десятком запросов, а отчёт клиенту («инвойс») строился из тех же чисел,
 * что видит оператор: расхождение отчёта с панелью — худшее, что тут может быть.
 *
 * Постатейно, а не в мелочах — прямая формулировка заказчика: клиенту нужны строки
 * «модуль → сделано действий → израсходовано», а не лог каждого комментария.
 */
import { listModuleKeys, getModuleStore } from './modules/registry.js'
import { tokenSummary, readLedger } from './tokenLedger.js'
import { getBalance, totalCoins, coinsByUser } from './balance.js'
import { moduleTitle } from './lib/moduleTitles.js'
import { loadAllMeta } from './accountsMeta.js'
import { listActivity } from './accountActivity.js'
import { readAudit } from './lib/auditLog.js'
import { listUsers } from './users.js'

/** Округление денег — до тысячных, как считает биллинг (строка парсера 0.005). */
const round2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Человекочитаемые имена модулей для отчёта клиенту. Держим здесь, а не тянем с фронта:
 * отчёт должен собираться на сервере целиком, иначе «инвойс» нельзя будет отдать
 * ни письмом, ни выгрузкой — только из открытой вкладки.
 */


/**
 * Свод для админ-панели.
 * @param {{since?:number}} [opts] начало периода (по умолчанию — последние 30 дней)
 */
export async function adminOverview(opts = {}) {
  const since = Number(opts.since) || Date.now() - 30 * DAY_MS

  // ── аккаунты ───────────────────────────────────────────────────────────
  const meta = await loadAllMeta().catch(() => ({}))
  const activity = await listActivity().catch(() => ({}))
  const accounts = { total: 0, byStatus: {}, resting: 0, tired: 0 }
  for (const [id, m] of Object.entries(meta)) {
    if (m?.inTrash) continue
    accounts.total += 1
    const st = m?.status || 'active'
    accounts.byStatus[st] = (accounts.byStatus[st] || 0) + 1
    const a = activity[id]
    if (a?.resting) accounts.resting += 1
    else if (a && a.threshold > 0 && a.fatigue / a.threshold >= 0.7) accounts.tired += 1
  }

  // ── задачи по модулям ──────────────────────────────────────────────────
  const tasks = { total: 0, byStatus: {}, byModule: {} }
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if (Number(t.createdAt) && t.createdAt < since) continue
      tasks.total += 1
      const st = t.status || 'unknown'
      tasks.byStatus[st] = (tasks.byStatus[st] || 0) + 1
      const m = (tasks.byModule[key] ||= { tasks: 0, done: 0, actions: 0 })
      m.tasks += 1
      if (t.status === 'done') m.done += 1
      m.actions += Number(t.progress?.done) || 0
    }
  }

  const [tokens, balance, coinTotal, users] = await Promise.all([
    tokenSummary({ since }).catch(() => ({ tokens: 0, coins: 0, calls: 0, byModule: {}, byAccount: {} })),
    getBalance().catch(() => null),
    totalCoins().catch(() => ({ coins: 0, wallets: 0 })),
    listUsers().catch(() => []),
  ])

  const audit = await readAudit({ limit: 1000 }).catch(() => [])
  const recent = audit.filter((e) => new Date(e.ts || 0).getTime() >= since)
  const byAction = {}
  for (const e of recent) byAction[e.action] = (byAction[e.action] || 0) + 1

  return {
    since,
    accounts,
    tasks,
    tokens,
    // balance — кошелёк по умолчанию (для совместимости), coinTotal — сумма по всем
    // пользователям: именно её показывает админ-панель как «монет в системе».
    balance,
    coinTotal,
    users: {
      total: users.length,
      active: users.filter((u) => u.active !== false).length,
    },
    audit: { total: recent.length, byAction },
  }
}

/**
 * Что делал КОНКРЕТНЫЙ аккаунт: задачи, действия, токены, деньги, лиды — по модулям.
 *
 * Профиль аккаунта (подписчики, статус, прокси) отвечает «кто он», но не «что он нам
 * принёс». Владелец покупает аккаунты за деньги и должен видеть отдачу каждого:
 * этот собрал 2 000 строк, а тот сжёг токены и привёл ноль лидов.
 * @param {string} accountId @param {{since?:number}} [opts]
 */
export async function accountReport(accountId, opts = {}) {
  const since = Number(opts.since) || 0
  const id = String(accountId || '')
  if (!id) return null

  const byModule = {}
  const mod = (key) => {
    if (!byModule[key]) byModule[key] = { moduleKey: key, title: moduleTitle(key), tasks: 0, actions: 0, tokens: 0, spent: 0 }
    return byModule[key]
  }

  let tasks = 0
  let actions = 0
  let spent = 0
  let errors = 0
  let lastUsed = 0
  const recent = []
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      const ids = t.settings?.accountIds || []
      if (!Array.isArray(ids) || !ids.includes(id)) continue
      if ((Number(t.createdAt) || 0) < since) continue
      // Действия задачи делим на число участвовавших аккаунтов: приписать все 500
      // комментариев каждому из пяти профилей значит впятеро завысить отдачу.
      const share = ids.length > 1 ? (Number(t.progress?.done) || 0) / ids.length : (Number(t.progress?.done) || 0)
      const coinShare = ids.length > 1 ? (Number(t.spentCoins) || 0) / ids.length : (Number(t.spentCoins) || 0)
      tasks += 1
      actions += share
      spent = round2(spent + coinShare)
      errors += Number(t.errors) || 0
      lastUsed = Math.max(lastUsed, Number(t.updatedAt) || Number(t.createdAt) || 0)
      const m = mod(key)
      m.tasks += 1
      m.actions += share
      m.spent = round2(m.spent + coinShare)
      recent.push({ id: t.id, moduleKey: key, title: moduleTitle(key), status: t.status, at: Number(t.updatedAt) || Number(t.createdAt) || 0, actions: Math.round(share) })
    }
  }

  // Токены журнал пишет с accountId — здесь делить ничего не надо, это точный расход.
  const ledger = await readLedger({ accountId: id, since: since || undefined, limit: 100000 }).catch(() => [])
  let tokens = 0
  let tokenCoins = 0
  for (const e of ledger) {
    tokens += Number(e.tokens) || 0
    tokenCoins = round2(tokenCoins + (Number(e.coins) || 0))
    if (e.module) mod(e.module).tokens += Number(e.tokens) || 0
  }

  // Лиды — конечный смысл работы аккаунта, а не побочная метрика.
  const { listLeads, ACTIVE_LEAD_STATUSES } = await import('./leads.js')
  const leads = (await listLeads({}).catch(() => [])).filter((l) => l.accountId === id)
  const leadsTarget = leads.filter((l) => l.status === 'target').length
  const leadsActive = leads.filter((l) => ACTIVE_LEAD_STATUSES.has(l.status)).length

  recent.sort((a, b) => b.at - a.at)
  return {
    accountId: id,
    since,
    tasks,
    actions: Math.round(actions),
    spent,
    tokens,
    tokenCoins,
    totalCoins: round2(spent + tokenCoins),
    errors,
    lastUsed,
    leads: { total: leads.length, active: leadsActive, target: leadsTarget },
    byModule: Object.values(byModule)
      .map((m) => ({ ...m, actions: Math.round(m.actions) }))
      .sort((a, b) => b.actions - a.actions || b.tokens - a.tokens),
    recent: recent.slice(0, 10),
  }
}

/**
 * §5.3: то, за чем владелец следит каждый день — где сейчас болит.
 *
 * Сводка отвечает «сколько всего сделано», но не «что сломалось». Задачи с ошибками,
 * аккаунты в бане и работа, вставшая из-за нуля на балансе, — это три разные беды с
 * разными действиями, поэтому считаем их отдельно, а не одной кучей «проблемы: 7».
 * @param {{since?:number}} [opts]
 */
export async function problems(opts = {}) {
  const since = Number(opts.since) || 0

  const failedTasks = []
  const pausedNoCoins = []
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if ((Number(t.createdAt) || 0) < since) continue
      const errors = Number(t.errors) || 0
      if (errors) {
        failedTasks.push({
          id: t.id, moduleKey: key, title: moduleTitle(key), status: t.status,
          errors, lastError: t.lastError || '', userId: t.userId || '',
        })
      }
      if (t.pausedByCoins) {
        pausedNoCoins.push({ id: t.id, moduleKey: key, title: moduleTitle(key), userId: t.userId || '' })
      }
    }
  }
  failedTasks.sort((a, b) => b.errors - a.errors)

  // Аккаунты: бан и flood — это простой оплаченного ресурса, их видно сразу.
  const meta = await loadAllMeta().catch(() => ({}))
  const accounts = { banned: [], flood: [], noProxy: [] }
  for (const [id, m] of Object.entries(meta || {})) {
    const st = String(m?.status || '')
    if (/ban|block/i.test(st)) accounts.banned.push({ id, status: st })
    else if (/flood/i.test(st) || m?.floodUntil > Date.now()) accounts.flood.push({ id, status: st, until: m?.floodUntil || 0 })
    if (!m?.proxyId) accounts.noProxy.push({ id })
  }

  return {
    since,
    failedTasks: failedTasks.slice(0, 20),
    failedTotal: failedTasks.length,
    pausedNoCoins,
    accounts: {
      banned: accounts.banned.length, flood: accounts.flood.length, noProxy: accounts.noProxy.length,
      bannedIds: accounts.banned.slice(0, 10), floodIds: accounts.flood.slice(0, 10),
    },
  }
}

/**
 * §5.3 + CRM: воронка лидов для админки.
 *
 * Отдельно считаем ЗАВИСШИЕ — активный лид, по которому давно ничего не происходило.
 * Их не видно ни в одном счётчике статусов, а именно они и есть потерянные деньги.
 * @param {{stuckDays?:number}} [opts]
 */
export async function crmOverview(opts = {}) {
  const stuckDays = Number(opts.stuckDays) || 3
  const { listLeads, LEAD_STATUSES, ACTIVE_LEAD_STATUSES } = await import('./leads.js')
  const leads = await listLeads({}).catch(() => [])

  const byStatus = Object.fromEntries(LEAD_STATUSES.map((k) => [k, 0]))
  const byAccount = {}
  const cutoff = Date.now() - stuckDays * DAY_MS
  let stuck = 0
  let hot = 0
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1
    if (l.accountId) byAccount[l.accountId] = (byAccount[l.accountId] || 0) + 1
    if (l.isHot || l.status === 'hot') hot += 1
    if (ACTIVE_LEAD_STATUSES.has(l.status) && (Number(l.updatedAt) || 0) < cutoff) stuck += 1
  }
  const target = byStatus.target || 0
  return {
    total: leads.length,
    byStatus,
    hot,
    stuck,
    stuckDays,
    target,
    // Конверсия в целевое действие — то, ради чего всё и делается.
    conversion: leads.length ? Math.round((target / leads.length) * 1000) / 10 : 0,
    byAccount,
  }
}

/**
 * §5.3: «трекинг пользователей» — разрез статистики ПО ЛЮДЯМ.
 *
 * Общая сумма отвечает «сколько всего потрачено», но не «кем». После перехода на
 * личные кошельки и личные задачи админ должен видеть, кто сколько запустил и
 * сколько с него списано: без этого претензию клиента «за что списали» разобрать
 * нечем. Строка = пользователь, а не задача — заказчик просил постатейно.
 * @param {{since?:number}} [opts]
 */
export async function usersReport(opts = {}) {
  const since = Number(opts.since) || 0
  const [users, coins, ledger] = await Promise.all([
    listUsers().catch(() => []),
    coinsByUser().catch(() => ({})),
    readLedger({ since: since || undefined, limit: 100000 }).catch(() => []),
  ])

  // Собираем задачи один раз и раскладываем по владельцу: задач много, юзеров мало.
  const byUser = new Map()
  const taskOwner = new Map() // taskId → userId, чтобы привязать старые записи журнала
  const touch = (id) => {
    if (!byUser.has(id)) byUser.set(id, { tasks: 0, actions: 0, spent: 0, tokens: 0, byModule: {} })
    return byUser.get(id)
  }
  /** Разрез «куда»: что человек делал в конкретном модуле. */
  const mod = (row, key) => {
    if (!row.byModule[key]) row.byModule[key] = { tasks: 0, actions: 0, tokens: 0, spent: 0 }
    return row.byModule[key]
  }
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if ((Number(t.createdAt) || 0) < since) continue
      // Задачи, заведённые до того, как стали запоминать владельца, считаем ничьими:
      // приписать их наугад хуже, чем честно показать отдельной строкой.
      const owner = t.userId || '—'
      taskOwner.set(t.id, owner)
      const row = touch(owner)
      const acts = Number(t.progress?.done) || 0
      const spent = Number(t.spentCoins) || 0
      row.tasks += 1
      row.actions += acts
      row.spent = round2(row.spent + spent)
      const m = mod(row, key)
      m.tasks += 1
      m.actions += acts
      m.spent = round2(m.spent + spent)
    }
  }

  // Токены: у свежих записей журнала есть userId, у старых — только taskId.
  // Привязываем через владельца задачи, иначе весь ранний расход выглядел бы ничьим.
  for (const e of ledger) {
    const owner = e.userId || taskOwner.get(e.taskId) || '—'
    const row = touch(owner)
    const tk = Number(e.tokens) || 0
    row.tokens += tk
    if (e.module) mod(row, e.module).tokens += tk
  }

  /** «Куда» — модули, отсортированные по весу: сначала где больше действий. */
  const where = (byModule) => Object.entries(byModule)
    .map(([key, v]) => ({ moduleKey: key, title: moduleTitle(key), ...v }))
    .sort((a, b) => b.actions - a.actions || b.tokens - a.tokens)

  const rows = users.map((u) => {
    const st = byUser.get(u.id) || { tasks: 0, actions: 0, spent: 0, tokens: 0, byModule: {} }
    byUser.delete(u.id)
    return {
      userId: u.id,
      email: u.email || '',
      name: u.name || '',
      active: u.active !== false,
      coins: round2(coins[u.id] ?? 0),
      tasks: st.tasks,
      actions: st.actions,
      spent: st.spent,
      tokens: st.tokens,
      where: where(st.byModule),
    }
  })

  // Владельцы, которых уже нет в списке юзеров (удалили), и задачи без владельца —
  // прятать нельзя: их действия и деньги реальны и должны сходиться с общим итогом.
  for (const [id, st] of byUser) {
    rows.push({
      userId: id,
      email: id === '—' ? 'без владельца (старые задачи)' : `удалённый пользователь ${id}`,
      name: '', active: false, coins: 0,
      tasks: st.tasks, actions: st.actions, spent: st.spent, tokens: st.tokens,
      where: where(st.byModule),
    })
  }

  rows.sort((a, b) => b.spent - a.spent || b.actions - a.actions)
  const totals = rows.reduce((acc, r) => ({
    coins: round2(acc.coins + r.coins),
    tasks: acc.tasks + r.tasks,
    actions: acc.actions + r.actions,
    spent: round2(acc.spent + r.spent),
    tokens: acc.tokens + r.tokens,
  }), { coins: 0, tasks: 0, actions: 0, spent: 0, tokens: 0 })

  return { since, rows, totals }
}

/**
 * §5.3/E2: «инвойс» — постатейный отчёт клиенту за период.
 * Строка = модуль: сколько задач, сколько действий, сколько израсходовано.
 * Никаких мелочей вроде отдельных комментариев — заказчик просил именно постатейно.
 * @param {{since?:number, until?:number}} [opts]
 */
export async function clientReport(opts = {}) {
  const since = Number(opts.since) || Date.now() - 30 * DAY_MS
  const until = Number(opts.until) || Date.now()

  const rows = []
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    const inPeriod = list.filter((t) => {
      const ts = Number(t.createdAt) || 0
      return ts >= since && ts <= until
    })
    if (!inPeriod.length) continue
    const actions = inPeriod.reduce((n, t) => n + (Number(t.progress?.done) || 0), 0)
    // Монеты клиента складываются из ДВУХ источников, и в счёте должны быть оба:
    // плата за действия (task.spentCoins, фикс по прайсу) и плата за токены ИИ.
    // Раньше в отчёт шли только токены — парсер на 111 действий показывал ноль монет,
    // то есть клиенту предъявляли меньше, чем с него списали.
    const actionCoins = round2(inPeriod.reduce((n, t) => n + (Number(t.spentCoins) || 0), 0))
    const tk = await tokenSummary({ module: key, since }).catch(() => ({ tokens: 0, coins: 0 }))
    rows.push({
      moduleKey: key,
      title: moduleTitle(key),
      tasks: inPeriod.length,
      completed: inPeriod.filter((t) => t.status === 'done').length,
      actions,
      tokens: tk.tokens,
      actionCoins,
      tokenCoins: tk.coins,
      coins: round2(actionCoins + tk.coins),
    })
  }
  rows.sort((a, b) => b.actions - a.actions)

  const totals = rows.reduce((acc, r) => ({
    tasks: acc.tasks + r.tasks,
    actions: acc.actions + r.actions,
    tokens: acc.tokens + r.tokens,
    actionCoins: round2(acc.actionCoins + r.actionCoins),
    tokenCoins: round2(acc.tokenCoins + r.tokenCoins),
    coins: round2(acc.coins + r.coins),
  }), { tasks: 0, actions: 0, tokens: 0, actionCoins: 0, tokenCoins: 0, coins: 0 })

  return { since, until, rows, totals }
}

/** Детализация расхода токенов — на случай вопроса «почему столько». */
export async function tokenDetails(filter = {}) {
  return readLedger({ limit: 200, ...filter })
}
