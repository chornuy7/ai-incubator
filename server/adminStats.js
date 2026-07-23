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
import { getBalance } from './balance.js'
import { loadAllMeta } from './accountsMeta.js'
import { listActivity } from './accountActivity.js'
import { readAudit } from './lib/auditLog.js'
import { listUsers } from './users.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Человекочитаемые имена модулей для отчёта клиенту. Держим здесь, а не тянем с фронта:
 * отчёт должен собираться на сервере целиком, иначе «инвойс» нельзя будет отдать
 * ни письмом, ни выгрузкой — только из открытой вкладки.
 */
const MODULE_TITLES = {
  mailing: 'Рассылка',
  autoposting: 'Автопостинг',
  'neuro-commenting': 'Нейрокомментинг',
  'neuro-chatting': 'Нейрочаттинг',
  'neuro-dialogs': 'НейроДиалоги',
  'mass-react': 'Массовые реакции',
  'mass-looking': 'Масслукинг',
  warming: 'Прогрев аккаунтов',
  parsing: 'Парсинг каналов',
  'parsing-groups': 'Парсер групп',
  'parsing-users': 'Парсер пользователей',
  'parsing-messages': 'Парсер сообщений',
  'parsing-comments': 'Парсер комментариев',
  ggr: 'AIR — AI Rating',
}
const moduleTitle = (key) => MODULE_TITLES[key] || key

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

  const [tokens, balance, users] = await Promise.all([
    tokenSummary({ since }).catch(() => ({ tokens: 0, coins: 0, calls: 0, byModule: {}, byAccount: {} })),
    getBalance().catch(() => null),
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
    balance,
    users: {
      total: users.length,
      active: users.filter((u) => u.active !== false).length,
    },
    audit: { total: recent.length, byAction },
  }
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
    const tk = await tokenSummary({ module: key, since }).catch(() => ({ tokens: 0, coins: 0 }))
    rows.push({
      moduleKey: key,
      title: moduleTitle(key),
      tasks: inPeriod.length,
      completed: inPeriod.filter((t) => t.status === 'done').length,
      actions,
      tokens: tk.tokens,
      coins: tk.coins,
    })
  }
  rows.sort((a, b) => b.actions - a.actions)

  const totals = rows.reduce((acc, r) => ({
    tasks: acc.tasks + r.tasks,
    actions: acc.actions + r.actions,
    tokens: acc.tokens + r.tokens,
    coins: Math.round((acc.coins + r.coins) * 100) / 100,
  }), { tasks: 0, actions: 0, tokens: 0, coins: 0 })

  return { since, until, rows, totals }
}

/** Детализация расхода токенов — на случай вопроса «почему столько». */
export async function tokenDetails(filter = {}) {
  return readLedger({ limit: 200, ...filter })
}
