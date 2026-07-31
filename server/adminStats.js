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
import { getBalance, totalCoins, coinsByUser, usdByUser } from './balance.js'
import { moduleTitle } from './lib/moduleTitles.js'
import { loadAllMeta } from './accountsMeta.js'
import { listActivity } from './accountActivity.js'
import { readAudit } from './lib/auditLog.js'
import { listUsers } from './users.js'
import { listRoles } from './roles.js'
import { normalizeStatus } from './lib/accountStatus.js'

/** Округление денег — до ТЫСЯЧНЫХ, как считает биллинг (строка парсера 0.005). */
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000

/**
 * ИИ, который тратит монеты вне модулей: подсказки в интерфейсе, классификатор
 * лидов, семантический фильтр. Клиент за них платит, значит видит их в счёте
 * своими словами, а не техническим ключом.
 */
const SERVICE_AI_TITLES = {
  'ai-help': 'Подсказки ИИ в интерфейсе',
  'lead-classifier': 'Классификация лидов',
  semantic: 'Семантический фильтр',
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Модуль → род активности для личной статистики. Комментинг даёт комментарии,
 * масс-реакции — реакции, чат/диалоги — сообщения и т. д. Это честный маппинг на
 * реальные действия задач: раньше «Моя статистика» рисовала эти же цифры моком.
 * Модули без явной категории (прогрев, парсеры, автопостинг) в KPI активности не
 * попадают — их вклад виден в разрезе «куда идёт работа».
 */
const ACTIVITY_OF_MODULE = {
  'neuro-commenting': 'comments',
  'mass-react': 'reactions',
  'neuro-chatting': 'messages',
  'neuro-dialogs': 'messages',
  'mass-looking': 'views',
  mailing: 'pm',
}

/**
 * Свод для админ-панели.
 * @param {{since?:number}} [opts] начало периода (по умолчанию — последние 30 дней)
 */
/**
 * §10.9: мониторинг здоровья аккаунтов для админки — сколько в работе, сколько
 * отдыхают и сколько «падают», с ПРИЧИНОЙ по каждому проблемному. Владелец должен
 * видеть не только «40 аккаунтов», а «3 в карантине после FloodWait, 1 забанен за спам».
 *
 * Раскладка статусов (accountStatus): healthy = active/warming (работают),
 * idle = pause (стоят по команде), problem = floodwait/quarantine/spamblock/reauth/invalid.
 */
const PROBLEM_STATUSES = new Set(['floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid'])
const HEALTHY_STATUSES = new Set(['active', 'warming'])
/** Человекочитаемая расшифровка статуса — для подписи в мониторинге. */
const STATUS_LABEL = {
  active: 'Активен', warming: 'Прогрев', pause: 'На паузе', floodwait: 'FloodWait',
  quarantine: 'Карантин', spamblock: 'Спам-блок', reauth: 'Нужен вход', invalid: 'Невалиден',
}

export async function accountsHealth() {
  const meta = await loadAllMeta().catch(() => ({}))
  const activity = await listActivity().catch(() => ({}))
  const out = {
    total: 0, healthy: 0, idle: 0, problem: 0, resting: 0, tired: 0,
    byStatus: {}, problems: [],
  }
  for (const [id, m] of Object.entries(meta)) {
    if (m?.inTrash) continue
    out.total += 1
    const st = normalizeStatus(m?.status)
    out.byStatus[st] = (out.byStatus[st] || 0) + 1
    if (HEALTHY_STATUSES.has(st)) out.healthy += 1
    else if (st === 'pause') out.idle += 1
    else if (PROBLEM_STATUSES.has(st)) {
      out.problem += 1
      // Причина: statusReason/Code (почему упал) + до какого времени (FloodWait/карантин).
      out.problems.push({
        id,
        name: m.name || m.username || m.phone || id,
        phone: m.phone || '',
        status: st,
        statusLabel: STATUS_LABEL[st] || st,
        reason: m.statusReason || m.statusCode || '',
        since: Number(m.statusSince) || 0,
        until: Number(m.statusUntil) || 0,
      })
    }
    const a = activity[id]
    if (a?.resting) out.resting += 1
    else if (a && a.threshold > 0 && a.fatigue / a.threshold >= 0.7) out.tired += 1
  }
  // Самые «свежие» проблемы сверху — их разбирают первыми.
  out.problems.sort((a, b) => b.since - a.since)
  return out
}

export async function adminOverview(opts = {}) {
  const since = Number(opts.since) || Date.now() - 30 * DAY_MS

  // ── аккаунты ───────────────────────────────────────────────────────────
  const meta = await loadAllMeta().catch(() => ({}))
  const activity = await listActivity().catch(() => ({}))
  const accounts = { total: 0, byStatus: {}, resting: 0, tired: 0 }
  for (const [id, m] of Object.entries(meta)) {
    if (m?.inTrash) continue
    accounts.total += 1
    // Нормализуем как в accountsHealth: иначе 'working'/'valid'/'' попадают в отдельные
    // корзины, и «Панель» и «Мониторинг» показывают один аккаунт под разными статусами.
    const st = normalizeStatus(m?.status)
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
 * Кто работает ПРЯМО СЕЙЧАС: запущенные задачи с прогрессом и владельцем.
 *
 * Сводка за период отвечает «что было», а владельцу чаще нужно «что идёт»: успеет
 * ли до ночи, не встало ли, кто это запустил. Ради этого не поднимаем отдельный
 * канал — тот же опрос, что и остальная панель.
 */
export async function activeNow() {
  const running = []
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if (t.status !== 'running' && t.status !== 'paused') continue
      const done = Number(t.progress?.done) || 0
      const total = Number(t.progress?.total) || 0
      running.push({
        id: t.id,
        moduleKey: key,
        title: moduleTitle(key),
        status: t.status,
        userId: t.userId || '',
        done,
        total,
        percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
        accounts: (t.settings?.accountIds || []).length,
        startedAt: Number(t.createdAt) || 0,
        updatedAt: Number(t.updatedAt) || 0,
        spentCoins: Number(t.spentCoins) || 0,
        pausedByCoins: !!t.pausedByCoins,
      })
    }
  }
  running.sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    running: running.filter((t) => t.status === 'running'),
    paused: running.filter((t) => t.status === 'paused'),
  }
}

/**
 * Расход по дням — чтобы видеть тренд, а не только итог за период.
 *
 * Источники разной точности, и мы их НЕ смешиваем в одну цифру: журнал токенов
 * пишет каждое обращение к ИИ с меткой времени (точно), а плата за действия
 * хранится итогом на задаче, без разбивки по дням, — её кладём на день создания
 * задачи. Подписи в интерфейсе говорят это прямо, иначе график врал бы точностью.
 * @param {{days?:number}} [opts]
 */
export async function dailySpend(opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 30))
  const since = Date.now() - days * DAY_MS
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

  const acc = new Map()
  const touch = (k) => {
    if (!acc.has(k)) acc.set(k, { day: k, tokens: 0, tokenCoins: 0, actionCoins: 0, tasks: 0, actions: 0 })
    return acc.get(k)
  }
  // Заполняем весь диапазон, включая пустые дни: провал в работе — тоже сигнал,
  // а «сжатый» график из трёх точек создаёт вид ровной нагрузки.
  for (let i = days - 1; i >= 0; i--) touch(dayKey(Date.now() - i * DAY_MS))
  // Границу берём ПО ДНЯМ, а не по «сейчас минус N суток»: скользящее окно на
  // несколько часов шире заполненного диапазона, и события попадали в лишний,
  // 31-й день — график просили за 30. Считаем только то, что внутри показанного.
  const firstDay = [...acc.keys()].sort()[0]
  const inRange = (ts) => dayKey(ts) >= firstDay

  const ledger = await readLedger({ since, limit: 100000 }).catch(() => [])
  for (const e of ledger) {
    const ts = Number(e.ts) || Date.now()
    if (!inRange(ts)) continue
    const row = touch(dayKey(ts))
    row.tokens += Number(e.tokens) || 0
    row.tokenCoins = round3(row.tokenCoins + (Number(e.coins) || 0))
  }

  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      const ts = Number(t.createdAt) || 0
      if (!ts || !inRange(ts)) continue
      const row = touch(dayKey(ts))
      row.tasks += 1
      row.actions += Number(t.progress?.done) || 0
      row.actionCoins = round3(row.actionCoins + (Number(t.spentCoins) || 0))
    }
  }

  const rows = [...acc.values()].sort((a, b) => a.day.localeCompare(b.day))
  for (const r of rows) r.coins = round3(r.tokenCoins + r.actionCoins)
  return { days, rows }
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
      spent = round3(spent + coinShare)
      // Ошибки делим так же, как действия: задача с 10 ошибками на 5 аккаунтов
      // давала каждому все 10, и во вкладке «Работа» выходило 50 вместо 10 —
      // подпись «частые ошибки, проверьте прокси» срабатывала на ровном месте.
      errors += ids.length > 1 ? (Number(t.errors) || 0) / ids.length : (Number(t.errors) || 0)
      lastUsed = Math.max(lastUsed, Number(t.updatedAt) || Number(t.createdAt) || 0)
      const m = mod(key)
      m.tasks += 1
      m.actions += share
      m.spent = round3(m.spent + coinShare)
      recent.push({ id: t.id, moduleKey: key, title: moduleTitle(key), status: t.status, at: Number(t.updatedAt) || Number(t.createdAt) || 0, actions: Math.round(share) })
    }
  }

  // Токены журнал пишет с accountId — здесь делить ничего не надо, это точный расход.
  const ledger = await readLedger({ accountId: id, since: since || undefined, limit: 100000 }).catch(() => [])
  let tokens = 0
  let tokenCoins = 0
  for (const e of ledger) {
    tokens += Number(e.tokens) || 0
    tokenCoins = round3(tokenCoins + (Number(e.coins) || 0))
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
    totalCoins: round3(spent + tokenCoins),
    errors: Math.round(errors),
    lastUsed,
    leads: { total: leads.length, active: leadsActive, target: leadsTarget },
    byModule: Object.values(byModule)
      .map((m) => ({ ...m, actions: Math.round(m.actions) }))
      .sort((a, b) => b.actions - a.actions || b.tokens - a.tokens),
    recent: recent.slice(0, 10),
  }
}

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
    if (m?.inTrash) continue // корзина — не проблема, это уже решение
    const st = String(m?.status || '')
    if (/ban|block/i.test(st)) accounts.banned.push({ id, status: st })
    else if (/flood/i.test(st) || m?.floodUntil > Date.now()) accounts.flood.push({ id, status: st, until: m?.floodUntil || 0 })
    // Прокси хранится в поле `proxy` строкой, «—» означает «не назначен».
    // Проверка на `proxyId` читала несуществующее поле и записывала в «без прокси»
    // все аккаунты подряд.
    const proxy = String(m?.proxy || '').trim()
    if (!proxy || proxy === '—') accounts.noProxy.push({ id })
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
  const since = Number(opts.since) || 0
  const { listLeads, LEAD_STATUSES, ACTIVE_LEAD_STATUSES } = await import('./leads.js')
  // Период учитываем, как на остальных вкладках: без этого переключение 7/30/90
  // дней перерисовывало страницу, а цифры CRM не менялись — читалось как залипание.
  const leads = (await listLeads({}).catch(() => []))
    .filter((l) => !since || (Number(l.createdAt) || 0) >= since)

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

  // Кто ведёт лида — это аккаунт, который с ним работает. Показываем именем, а не
  // id: «acc_99a46d69fa1e привёл 12 лидов» не читается человеком.
  const meta = await loadAllMeta().catch(() => ({}))
  const owners = Object.entries(byAccount)
    .map(([id, count]) => ({
      accountId: id,
      name: meta?.[id]?.name || meta?.[id]?.username || id,
      count,
    }))
    .sort((a, b) => b.count - a.count)

  return {
    total: leads.length,
    byStatus,
    hot,
    stuck,
    stuckDays,
    target,
    // Конверсия в целевое действие — то, ради чего всё и делается.
    conversion: leads.length ? Math.round((target / leads.length) * 1000) / 10 : 0,
    owners,
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
  const [users, coins, usd, ledger, roles] = await Promise.all([
    listUsers().catch(() => []),
    coinsByUser().catch(() => ({})),
    usdByUser().catch(() => ({})), // §11.4: денежный остаток ($) по каждому — «На счету» в админке
    readLedger({ since: since || undefined, limit: 100000 }).catch(() => []),
    listRoles().catch(() => []),
  ])
  // §10.4: имя роли на карточку — из roleIds юзера собираем читаемые названия.
  const roleNameById = new Map(roles.map((r) => [r.id, r.name]))
  const roleNamesOf = (u) => (u.roleIds || []).map((id) => roleNameById.get(id)).filter(Boolean).join(' + ')

  // Подписка каждого: какие модули ему открыты. 'all' — набор не выбран (открыто всё).
  // Нужно админу, чтобы прямо в списке видеть, кто на что подписан.
  const modsByUser = {}
  await Promise.all(users.map(async (u) => {
    try { modsByUser[u.id] = (await getBalance(u.id)).modules } catch { modsByUser[u.id] = 'all' }
  }))
  const subOf = (mods) => {
    if (mods === 'all' || mods == null) return { all: true, count: 0, titles: [], keys: [] }
    const arr = Array.isArray(mods) ? mods : []
    return { all: false, count: arr.length, titles: arr.map((k) => moduleTitle(k)), keys: arr }
  }

  // Собираем задачи один раз и раскладываем по владельцу: задач много, юзеров мало.
  const byUser = new Map()
  const taskOwner = new Map() // taskId → userId, чтобы привязать старые записи журнала
  const touch = (id) => {
    if (!byUser.has(id)) byUser.set(id, { tasks: 0, actions: 0, spent: 0, tokens: 0, byModule: {}, log: [] })
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
      row.spent = round3(row.spent + spent)
      const m = mod(row, key)
      m.tasks += 1
      m.actions += acts
      m.spent = round3(m.spent + spent)
      // Сами запуски, а не только итоги: на вопрос «что он делал в среду» сумма
      // за период не отвечает — нужен список с датами.
      row.log.push({
        id: t.id, moduleKey: key, title: moduleTitle(key), status: t.status,
        actions: acts, spent, at: Number(t.createdAt) || 0, finishedAt: Number(t.updatedAt) || 0,
        errors: Number(t.errors) || 0,
      })
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

  // §10.4: имя родителя для «суб-юзер под <кем>» — по id из того же списка.
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email || u.id]))

  // §11.9: последний вход и IP — из аудита (action='user.login'). Нужно, чтобы админ
  // видел, откуда заходят: сценарий со звонка — доступ забрал уволенный сотрудник.
  // Аудит пишется по e-mail (initiator), поэтому и мапим по нему; берём самую свежую
  // запись (readAudit отдаёт в обратном порядке — первая встреченная и есть последняя).
  const lastLoginByEmail = new Map()
  try {
    const { readAudit } = await import('./lib/auditLog.js')
    for (const e of await readAudit({ action: 'user.login', limit: 1000 })) {
      const key = String(e.initiator || '').toLowerCase()
      if (!key || lastLoginByEmail.has(key)) continue
      lastLoginByEmail.set(key, { at: e.ts || e.time || 0, ip: e.meta?.ip || '' })
    }
  } catch { /* аудита нет — просто не покажем последний вход */ }

  const rows = users.map((u) => {
    const st = byUser.get(u.id) || { tasks: 0, actions: 0, spent: 0, tokens: 0, byModule: {}, log: [] }
    byUser.delete(u.id)
    return {
      userId: u.id,
      email: u.email || '',
      name: u.name || '',
      active: u.active !== false,
      // §10.4: вложенность — кто чей суб-юзер. parentName для показа без второго запроса.
      parentId: u.parentId || null,
      parentName: u.parentId ? (nameById.get(u.parentId) || null) : null,
      // §10.4: роль(и) юзера — читаемым именем на карточку + id для назначения из админки.
      roleName: roleNamesOf(u) || null,
      roleIds: u.roleIds || [],
      coins: round3(coins[u.id] ?? 0),
      // §11.4: денежный остаток ($) — основной кошелёк, показывается прежде токенов.
      usd: Math.round((usd[u.id] ?? 0) * 100) / 100,
      // §11.9: когда и с какого IP заходил последний раз (null — входов в аудите нет).
      lastLogin: lastLoginByEmail.get(String(u.email || '').toLowerCase()) || null,
      subscription: subOf(modsByUser[u.id]),
      tasks: st.tasks,
      actions: st.actions,
      spent: st.spent,
      tokens: st.tokens,
      where: where(st.byModule),
      log: st.log.sort((a, b) => b.at - a.at).slice(0, 100),
    }
  })

  // Владельцы, которых уже нет в списке юзеров (удалили), и задачи без владельца —
  // прятать нельзя: их действия и деньги реальны и должны сходиться с общим итогом.
  for (const [id, st] of byUser) {
    rows.push({
      userId: id,
      email: id === '—' ? 'без владельца (старые задачи)' : `удалённый пользователь ${id}`,
      name: '', active: false, coins: 0, usd: 0, subscription: null,
      tasks: st.tasks, actions: st.actions, spent: st.spent, tokens: st.tokens,
      where: where(st.byModule),
      log: st.log.sort((a, b) => b.at - a.at).slice(0, 100),
    })
  }

  rows.sort((a, b) => b.spent - a.spent || b.actions - a.actions)
  const totals = rows.reduce((acc, r) => ({
    coins: round3(acc.coins + r.coins),
    usd: Math.round((acc.usd + (r.usd || 0)) * 100) / 100,
    tasks: acc.tasks + r.tasks,
    actions: acc.actions + r.actions,
    spent: round3(acc.spent + r.spent),
    tokens: acc.tokens + r.tokens,
  }), { coins: 0, usd: 0, tasks: 0, actions: 0, spent: 0, tokens: 0 })

  // §10.4: курс монета→$ для показа баланса «в долларах» — единый хелпер priceStore.
  let coinUsd = 0
  try { const { coinUsdRate } = await import('./priceStore.js'); coinUsd = await coinUsdRate() } catch { /* нет прайса */ }

  return { since, rows, totals, coinUsd }
}

/**
 * §5.3: ЛИЧНАЯ статистика одного пользователя — его задачи, действия, расходы и
 * активность по модулям. Зеркалит usersReport, но для «своего» среза: сюда не
 * попадают ни другие люди, ни деньги пространства — только то, что запускал и
 * тратил он сам. Демо (без сессии) сюда не ходит — там фронт показывает моки.
 * @param {string} userId @param {{since?:number}} [opts]
 */
export async function myStats(userId, opts = {}) {
  const uid = String(userId || '')
  const since = Number(opts.since) || 0
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

  const byModule = {}
  const activity = { comments: 0, reactions: 0, messages: 0, views: 0, pm: 0 }
  const daily = new Map()
  const log = []
  let tasks = 0, actions = 0, spent = 0, tokens = 0
  const myTaskIds = new Set()

  const touchDay = (k) => {
    if (!daily.has(k)) daily.set(k, { day: k, comments: 0, reactions: 0, messages: 0, views: 0, pm: 0, actions: 0, tokens: 0, coins: 0 })
    return daily.get(k)
  }
  const mod = (key) => {
    if (!byModule[key]) byModule[key] = { tasks: 0, actions: 0, tokens: 0, spent: 0 }
    return byModule[key]
  }

  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if (t.userId !== uid) continue // только свои задачи
      if ((Number(t.createdAt) || 0) < since) continue
      myTaskIds.add(t.id)
      const acts = Number(t.progress?.done) || 0
      const sp = Number(t.spentCoins) || 0
      tasks += 1; actions += acts; spent = round3(spent + sp)
      const m = mod(key); m.tasks += 1; m.actions += acts; m.spent = round3(m.spent + sp)
      const cat = ACTIVITY_OF_MODULE[key]
      const d = touchDay(dayKey(Number(t.createdAt) || Date.now()))
      d.actions += acts; d.coins = round3(d.coins + sp)
      if (cat) { activity[cat] += acts; d[cat] += acts }
      log.push({
        id: t.id, moduleKey: key, title: moduleTitle(key), status: t.status,
        actions: acts, spent: sp, at: Number(t.createdAt) || 0, finishedAt: Number(t.updatedAt) || 0,
        errors: Number(t.errors) || 0,
      })
    }
  }

  // Токены ИИ: у свежих записей журнала есть userId, у старых — только taskId,
  // который мы уже собрали в myTaskIds. Иначе ранний расход выглядел бы ничьим.
  const ledger = await readLedger({ since: since || undefined, limit: 100000 }).catch(() => [])
  for (const e of ledger) {
    if (!(e.userId === uid || (e.taskId && myTaskIds.has(e.taskId)))) continue
    const tk = Number(e.tokens) || 0
    tokens += tk
    if (e.module) mod(e.module).tokens += tk
    const d = touchDay(dayKey(Number(e.ts) || Date.now()))
    d.tokens += tk; d.coins = round3(d.coins + (Number(e.coins) || 0))
  }

  const where = Object.entries(byModule)
    .map(([key, v]) => ({ moduleKey: key, title: moduleTitle(key), ...v }))
    .sort((a, b) => b.actions - a.actions || b.tokens - a.tokens)

  const { coins } = await getBalance(uid).catch(() => ({ coins: 0 }))
  log.sort((a, b) => b.at - a.at)

  return {
    since,
    coins: round3(coins),
    totals: { tasks, actions, spent, tokens },
    activity,
    where,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    log: log.slice(0, 200),
  }
}

/**
 * §5.3: что и сколько «куплено» — ПОПОЛНЕНИЯ кошельков (положительные операции)
 * по каждому пользователю. Отвечает на «кто сколько занёс», отдельно от «кто
 * сколько потратил» (это usersReport): списания — не покупка и сюда не идут.
 * @param {{since?:number}} [opts]
 */
export async function purchasesReport(opts = {}) {
  const since = Number(opts.since) || 0
  const { walletHistory } = await import('./balance.js')
  const [rowsRaw, users] = await Promise.all([
    walletHistory({ since: since || undefined, limit: 1000 }).catch(() => []),
    listUsers().catch(() => []),
  ])
  const nameOf = new Map(users.map((u) => [u.id, u.name || u.email || u.id]))
  const emailOf = new Map(users.map((u) => [u.id, u.email || '']))

  const byUser = new Map()
  const feed = []
  let boughtTotal = 0
  for (const r of rowsRaw) {
    const amount = Number(r.amount) || 0
    if (amount <= 0) continue // только пополнения/начисления, не списания
    const id = r.userId || '—'
    if (!byUser.has(id)) {
      byUser.set(id, { userId: id, name: nameOf.get(id) || (id === '__default' ? 'Системный кошелёк' : id), email: emailOf.get(id) || '', count: 0, coins: 0, lastAt: 0 })
    }
    const u = byUser.get(id)
    u.count += 1; u.coins = round3(u.coins + amount); u.lastAt = Math.max(u.lastAt, Number(r.ts) || 0)
    boughtTotal = round3(boughtTotal + amount)
    feed.push({ ts: Number(r.ts) || 0, userId: id, name: u.name, email: u.email, amount, reason: r.reason || '' })
  }

  // Покупки планов ($): события подписки из журнала. Каждая — покупка ИЛИ продление
  // набора модулей; сумма в валюте подписки, а не в монетах. Набор «all» (не выбирали)
  // это не покупка — пропускаем.
  const { CURRENCY } = await import('./pricing.js')
  const auditRows = await readAudit({ action: 'subscription.set', limit: 5000 }).catch(() => [])
  const planFeed = []
  let planTotal = 0
  for (const e of auditRows) {
    const ts = Number(e.ts) || 0
    if (since && ts < since) continue
    const sum = Number(e.meta?.paid ?? e.meta?.cost?.sum) || 0
    if (sum <= 0) continue // 'all'/пустой набор — не покупка
    const id = e.initiator && e.initiator !== 'system' ? e.initiator : '—'
    const mods = e.meta?.modules
    planTotal = round3(planTotal + sum)
    planFeed.push({
      ts,
      userId: id,
      name: nameOf.get(id) || (id === '—' ? 'система' : id),
      email: emailOf.get(id) || '',
      amount: sum,
      modulesCount: mods === 'all' ? -1 : (Array.isArray(mods) ? mods.length : 0),
      reason: e.reason || '',
    })
  }
  planFeed.sort((a, b) => b.ts - a.ts)

  return {
    since,
    boughtTotal,
    count: feed.length,
    rows: [...byUser.values()].sort((a, b) => b.coins - a.coins),
    // Отдаём до 500 последних операций за период — иначе «глянуть месяц назад»
    // упирается в срез, и поиск не находит то, что дальше сотни. Полноценная глубокая
    // история — отдельная задача (диапазон дат from–to + пагинация).
    feed: feed.sort((a, b) => b.ts - a.ts).slice(0, 500),
    plans: { currency: CURRENCY, total: planTotal, count: planFeed.length, feed: planFeed.slice(0, 500) },
  }
}

/**
 * §5.3/E2: «инвойс» — постатейный отчёт клиенту за период.
 * Строка = модуль: сколько задач, сколько действий, сколько израсходовано.
 * Никаких мелочей вроде отдельных комментариев — заказчик просил именно постатейно.
 * @param {{since?:number, until?:number, userId?:string}} [opts]
 */
export async function clientReport(opts = {}) {
  const since = Number(opts.since) || Date.now() - 30 * DAY_MS
  const until = Number(opts.until) || Date.now()
  // Отчёт по КОНКРЕТНОМУ клиенту (клиентов может быть больше одного): считаем только
  // его задачи и его расход ИИ. Пусто — общий отчёт по всему проекту.
  const userId = opts.userId ? String(opts.userId) : ''

  // Журнал ИИ читаем ОДИН раз и режем по периоду сами: tokenSummary на каждый
  // модуль перечитывал весь файл по разу на модуль, а верхнюю границу `until`
  // вообще не применял — отчёт за закрытый период втягивал расход после него.
  const ledger = (await readLedger({ since, limit: 100000 }).catch(() => []))
    .filter((e) => {
      const ts = Number(e.ts) || 0
      if (userId && e.userId !== userId) return false
      return ts >= since && ts <= until
    })
  const aiByModule = new Map()
  for (const e of ledger) {
    const k = String(e.module || '')
    if (!aiByModule.has(k)) aiByModule.set(k, { tokens: 0, coins: 0 })
    const row = aiByModule.get(k)
    row.tokens += Number(e.tokens) || 0
    row.coins = round3(row.coins + (Number(e.coins) || 0))
  }

  const rows = []
  const moduleKeys = new Set(listModuleKeys())
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    const inPeriod = list.filter((t) => {
      const ts = Number(t.createdAt) || 0
      if (userId && t.userId !== userId) return false
      return ts >= since && ts <= until
    })
    // Модуль без новых задач мог всё равно жечь токены — старой, ещё идущей
    // задачей. Пропустить его значило бы потерять эти деньги из счёта.
    if (!inPeriod.length && !aiByModule.get(key)?.tokens) continue
    const actions = inPeriod.reduce((n, t) => n + (Number(t.progress?.done) || 0), 0)
    // Монеты клиента складываются из ДВУХ источников, и в счёте должны быть оба:
    // плата за действия (task.spentCoins, фикс по прайсу) и плата за токены ИИ.
    // Раньше в отчёт шли только токены — парсер на 111 действий показывал ноль монет,
    // то есть клиенту предъявляли меньше, чем с него списали.
    const actionCoins = round3(inPeriod.reduce((n, t) => n + (Number(t.spentCoins) || 0), 0))
    const tk = aiByModule.get(key) || { tokens: 0, coins: 0 }
    rows.push({
      moduleKey: key,
      title: moduleTitle(key),
      tasks: inPeriod.length,
      completed: inPeriod.filter((t) => t.status === 'done').length,
      actions,
      tokens: tk.tokens,
      actionCoins,
      tokenCoins: tk.coins,
      coins: round3(actionCoins + tk.coins),
    })
  }
  // Служебный ИИ (подсказки, классификатор лидов, семантика) списывает с того же
  // кошелька, но модулем не является. Раньше он выпадал из счёта целиком: клиент
  // платил, а в документе этих денег не было.
  for (const [key, tk] of aiByModule) {
    if (moduleKeys.has(key) || !tk.tokens) continue
    rows.push({
      moduleKey: key,
      title: SERVICE_AI_TITLES[key] || `Сервисный ИИ (${key || 'без модуля'})`,
      tasks: 0,
      completed: 0,
      actions: 0,
      tokens: tk.tokens,
      actionCoins: 0,
      tokenCoins: tk.coins,
      coins: tk.coins,
    })
  }

  rows.sort((a, b) => b.actions - a.actions)

  const totals = rows.reduce((acc, r) => ({
    tasks: acc.tasks + r.tasks,
    actions: acc.actions + r.actions,
    tokens: acc.tokens + r.tokens,
    actionCoins: round3(acc.actionCoins + r.actionCoins),
    tokenCoins: round3(acc.tokenCoins + r.tokenCoins),
    coins: round3(acc.coins + r.coins),
  }), { tasks: 0, actions: 0, tokens: 0, actionCoins: 0, tokenCoins: 0, coins: 0 })

  return { since, until, rows, totals }
}

/** Детализация расхода токенов — на случай вопроса «почему столько». */
export async function tokenDetails(filter = {}) {
  return readLedger({ limit: 200, ...filter })
}

/**
 * §11.1: полный журнал активности КОНКРЕТНОГО юзера для админки.
 *
 * Со звонка 29.07: «мы должны видеть все логи, всю активность, все действия по любому
 * юзеру» — это ответственность владельца платформы за то, что делают чужие люди нашими
 * аккаунтами, а не удобство. Поэтому здесь не выжимка, а сырой поток событий.
 *
 * Аудит писался исторически по-разному: initiator бывает и id (`usr_admin`), и e-mail
 * (`user.login`), поэтому матчим по обоим. Плюс отдаём события, где юзер — ОБЪЕКТ
 * действия (`meta.userId`): «админ поменял ему баланс/роль» тоже часть его истории,
 * и отличаем их флагом `bySelf`.
 *
 * ⚠️ Известный пробел: часть записей пишется с initiator='operator' (обезличенно) —
 * такие события attribution не поддаются и в журнал юзера не попадут. Исправляется
 * не здесь, а на местах записи аудита (передавать реального инициатора).
 */
export async function userActivity({ userId, limit = 300, action = '' } = {}) {
  const users = await listUsers()
  const u = users.find((x) => x.id === userId)
  const email = String(u?.email || '').toLowerCase()
  const id = String(userId || '').toLowerCase()
  const keys = new Set([id, email].filter(Boolean))
  if (!keys.size) return { userId, email: '', rows: [], total: 0, actions: [] }

  const rows = []
  const seenActions = new Set()
  for (const e of await readAudit({ limit: 100000 })) {
    const init = String(e.initiator || '').toLowerCase()
    const target = String(e.meta?.userId || '').toLowerCase()
    const bySelf = keys.has(init)
    if (!bySelf && !(target && keys.has(target))) continue
    seenActions.add(e.action)
    if (action && e.action !== action) continue
    rows.push({
      ts: e.ts,
      action: e.action,
      module: e.module || '',
      reason: e.reason || '',
      // Полезное для разбора: откуда зашёл и какой аккаунт затронут.
      ip: e.meta?.ip || '',
      account: e.account || '',
      bySelf,
    })
  }
  return {
    userId,
    email: u?.email || '',
    total: rows.length,
    rows: rows.slice(0, limit),
    actions: [...seenActions].sort(),
  }
}

/**
 * §11.1: «с кем переписывается» — диалоги (лиды), которые ведут аккаунты этого юзера.
 *
 * Со звонка 29.07 это часть той же ответственности: владелец платформы отвечает за то,
 * что чужие люди делают его Telegram-аккаунтами, и должен видеть не только «что запускал»,
 * но и с кем идёт переписка.
 *
 * Связь юзер→диалог строим двумя путями, потому что одного не хватает:
 *   • лид создан после §11.3 — у него есть свой `userId`;
 *   • лид старый (владельца нет) — но его аккаунт участвовал в задаче этого юзера,
 *     значит переписку вёл он. Поэтому собираем аккаунты из его задач.
 *
 * Тексты сообщений НЕ отдаём: их хранение — открытый вопрос (приватность и объём),
 * пока показываем «кто, каким аккаунтом, в каком статусе и когда» — это отвечает на
 * вопрос «с кем переписывается», не создавая нового хранилища.
 */
export async function userDialogs({ userId, limit = 200 } = {}) {
  if (!userId) return { userId, rows: [], total: 0, accounts: 0 }

  // 1. Аккаунты, которыми этот юзер работал (из его задач по всем модулям).
  const accountIds = new Set()
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let list = []
    try { list = await store.listTasks() } catch { continue }
    for (const t of list) {
      if (t.userId !== userId) continue
      for (const a of t.settings?.accountIds || []) accountIds.add(a)
    }
  }

  // 2. Лиды: свои по владельцу ИЛИ по аккаунтам из его задач.
  const { listLeads } = await import('./leads.js')
  const all = await listLeads({}).catch(() => [])
  const mine = all.filter((l) => l.userId === userId || (l.accountId && accountIds.has(l.accountId)))

  // 3. Имя аккаунта вместо id — админ разбирает инцидент, а не читает хэши.
  const meta = await loadAllMeta().catch(() => ({}))
  const rows = mine
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
    .map((l) => ({
      id: l.id,
      peer: l.peer || '',
      accountId: l.accountId || '',
      accountName: meta[l.accountId]?.name || l.accountId || '',
      status: l.status || '',
      isHot: !!l.isHot,
      note: l.note || '',
      // По какому пути связали — чтобы не гадать, откуда взялся чужой на вид диалог.
      viaOwner: l.userId === userId,
      at: l.updatedAt || l.createdAt || 0,
    }))

  return { userId, rows, total: mine.length, accounts: accountIds.size }
}
