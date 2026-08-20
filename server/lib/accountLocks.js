/**
 * Глобальные блокировки аккаунтов.
 *
 * С 20.08 (решение владельца) правило смягчено: «один аккаунт = одна задача» →
 * «один аккаунт = один модуль КАЖДОГО типа». Аккаунт может одновременно числиться в
 * мейлинге, комментинге и реакциях, но не в двух мейлингах сразу — иначе они дублировали
 * бы работу. Физическую одновременность (два действия в одну секунду) исключает
 * отдельный реестр занятости — accountBusy.js: там же пауза при переключении модулей.
 * Карантин и прочие нерабочие статусы отсекаются на исполнении (isAccountRunnable +
 * canWorkNow) — карантинный аккаунт ни один модуль не возьмёт.
 */

/**
 * Значение — ПЕРВЫЙ держатель (обратная совместимость с UI) + полный список держателей
 * в `holders` (первый элемент дублирует верхний уровень).
 * @typedef {{ moduleKey: string, taskId: string, moduleLabel: string, goalId?: string|null, since: number }} Holder
 * @type {Map<string, Holder & { holders: Holder[], alsoLabels: string[] }>}
 */
const locks = new Map()

/** Пересобрать значение лока из списка держателей (первый — «лицо» для UI). */
function packHolders(holders) {
  const [head, ...rest] = holders
  return { ...head, holders, alsoLabels: rest.map((h) => h.moduleLabel) }
}

/**
 * Реестр задач, у которых прямо сейчас крутится воркер в этом процессе.
 * Блокировки, чей taskId не «живой» и не running/queued на диске, считаются устаревшими.
 * @type {Set<string>}
 */
const liveTasks = new Set()

export const MODULE_LABELS = {
  mailing: 'Мейлинг',
  autoposting: 'Автопостинг',
  'neuro-commenting': 'Нейрокомментинг',
  'neuro-chatting': 'Нейрочаттинг',
  'mass-react': 'Массовые реакции',
  'mass-looking': 'Масслукинг',
  warming: 'Прогрев',
  'neuro-dialogs': 'НейроДиалоги',
  ggr: 'GGR · Рейтинг',
  parsing: 'Парсинг',
  'parsing-groups': 'Парсинг групп',
  'parsing-users': 'Парсинг юзеров',
  'parsing-messages': 'Парсинг сообщений',
  'parsing-comments': 'Парсинг комментариев',
}

/** @param {string} moduleKey */
export function moduleLabel(moduleKey) {
  return MODULE_LABELS[/** @type {keyof typeof MODULE_LABELS} */ (moduleKey)] || moduleKey
}

/** @param {string} accountId */
export function getAccountLock(accountId) {
  return locks.get(accountId) ?? null
}

/** @returns {Record<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
export function getAllAccountLocks() {
  /** @type {Record<string, { moduleKey: string, taskId: string, moduleLabel: string, since: number }>} */
  const out = {}
  for (const [id, lock] of locks) out[id] = { ...lock }
  return out
}

/** Как getAllAccountLocks, но с текущим статусом задачи (running/paused/…) — чтобы UI мог
 *  показать «на паузе в модуле X», а не только «в работе». @returns {Promise<Record<string, object>>} */
export async function getAllAccountLocksDetailed() {
  /** @type {Record<string, object>} */
  const out = {}
  for (const [id, lock] of locks) {
    const status = await findTaskStatus(lock.taskId)
    out[id] = { ...lock, taskStatus: status || 'running' }
  }
  return out
}

/**
 * Прогрев — ЕДИНСТВЕННОЕ исключение из многомодульности (§3.3 ТЗ).
 *
 * Пока профиль греется, он по определению ещё не готов к бою: смысл прогрева в том,
 * чтобы Telegram увидел человеческую историю до первого холодного сообщения. Поэтому
 * прогрев не делит аккаунт ни с кем — ни он к работающему, ни работа к нему.
 * До 20.08 это держал общий лок «один аккаунт = одна задача»; когда его смягчили,
 * запрет пришлось выразить явно, иначе «Мейлинг + Прогрев на тех же 20 аккаунтах»
 * проходил без единого возражения.
 */
const EXCLUSIVE_MODULES = new Set(['warming'])
const conflicts = (a, b) => a === b || EXCLUSIVE_MODULES.has(a) || EXCLUSIVE_MODULES.has(b)

/**
 * Захват аккаунтов задачей. Конфликт с задачей ТОГО ЖЕ модуля (два мейлинга на одном
 * аккаунте дублировали бы работу) и с прогревом в любую сторону; мейлинг + комментинг —
 * разрешённая многомодульность (решение владельца 20.08).
 * @param {string[]} accountIds @param {string} moduleKey @param {string} taskId
 * @param {{ force?: boolean, goalId?: string }} [opts]
 */
export function tryAcquireLocks(accountIds, moduleKey, taskId, opts = {}) {
  const label = moduleLabel(moduleKey)
  /** @type {{ accountId: string, moduleLabel: string }[]} */
  const clashes = []

  for (const accountId of accountIds || []) {
    const existing = locks.get(accountId)
    if (!existing) continue
    const clash = existing.holders.find((h) => h.taskId !== taskId && conflicts(moduleKey, h.moduleKey))
    if (clash) clashes.push({ accountId, moduleLabel: clash.moduleLabel })
  }

  if (clashes.length && !opts.force) {
    const names = clashes.map((c) => `${c.accountId.slice(-6)} → ${c.moduleLabel}`).join(', ')
    const warm = moduleKey === 'warming'
      ? 'Прогрев не делит аккаунт с другими модулями: профиль греется, пока не готов к работе.'
      : 'Аккаунты уже заняты несовместимой задачей.'
    return `${warm} ${names}. Остановите её или выберите другие профили.`
  }

  for (const accountId of accountIds || []) {
    const holder = { moduleKey, taskId, moduleLabel: label, goalId: opts.goalId || null, since: Date.now() }
    const prev = locks.get(accountId)
    if (!prev) { locks.set(accountId, packHolders([holder])); continue }
    // force перехватывает слоты НЕСОВМЕСТИМЫХ задач (тот же модуль либо прогрев);
    // держателей совместимых модулей не трогаем — их работа продолжается.
    let holders = prev.holders.filter((h) => !(conflicts(moduleKey, h.moduleKey) && h.taskId !== taskId))
    if (!holders.some((h) => h.taskId === taskId && h.moduleKey === moduleKey)) holders = [...holders, holder]
    locks.set(accountId, packHolders(holders))
  }
  return null
}

/** @param {string} taskId */
export function releaseTaskLocks(taskId) {
  for (const [accountId, lock] of locks) {
    const holders = lock.holders.filter((h) => h.taskId !== taskId)
    if (!holders.length) locks.delete(accountId)
    else if (holders.length !== lock.holders.length) locks.set(accountId, packHolders(holders))
  }
}

/**
 * Принудительно снять блокировку (ручной разблок стухшего лока).
 *
 * С многомодульностью держателей может быть несколько, поэтому снимать «всю запись»
 * опасно: оператор жал «Освободить» из-за зависшего мейлинга, а заодно сносил прогрев,
 * который трогать нельзя (§12, аудит 20.08). Без `moduleKey` поведение прежнее — снять
 * всё, — но вызывающие с гейтом прав обязаны указывать, кого именно освобождают.
 * @param {string} accountId @param {{ moduleKey?: string, taskId?: string }} [opts]
 */
export function forceReleaseAccount(accountId, opts = {}) {
  const lock = locks.get(accountId)
  if (!lock) return null
  const { moduleKey, taskId } = opts
  if (!moduleKey && !taskId) { locks.delete(accountId); return lock }
  const hit = lock.holders.filter((h) => (!moduleKey || h.moduleKey === moduleKey) && (!taskId || h.taskId === taskId))
  if (!hit.length) return null
  const rest = lock.holders.filter((h) => !hit.includes(h))
  if (rest.length) locks.set(accountId, packHolders(rest))
  else locks.delete(accountId)
  return hit[0]
}

/** @param {string} accountId @param {string} [taskId] */
export function assertAccountAvailable(accountId, taskId) {
  const lock = locks.get(accountId)
  if (!lock) return
  // Многомодульность (20.08): задаче достаточно быть ЛЮБЫМ из держателей — остальные
  // модули работают с этим же аккаунтом параллельно, это разрешено.
  if (taskId && lock.holders.some((h) => h.taskId === taskId)) return
  throw new Error(`ACCOUNT_BUSY:${lock.moduleLabel}`)
}

// ── Живой реестр воркеров ──────────────────────────────────────────────

/** @param {string} taskId */
export function markTaskLive(taskId) {
  if (taskId) liveTasks.add(taskId)
}

/** @param {string} taskId */
export function markTaskDone(taskId) {
  liveTasks.delete(taskId)
}

/** @param {string} taskId */
export function isTaskLive(taskId) {
  return liveTasks.has(taskId)
}

// ── Согласование блокировок с реальным состоянием ──────────────────────

/**
 * Найти статус задачи по её id среди всех стораджей (universal + neuro-commenting).
 * @param {string} taskId
 * @returns {Promise<string | null>}
 */
async function findTaskStatus(taskId) {
  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const t = await store.loadTask(taskId)
      if (t) return t.status || null
    }
  } catch { /* ignore */ }

  try {
    const { loadTask } = await import('../neuroCommenting/taskStore.js')
    const t = await loadTask(taskId)
    if (t) return t.status || null
  } catch { /* ignore */ }

  return null
}

/**
 * Самолечение: снять блокировки, чей taskId не «живой» в процессе
 * и не имеет статуса running/queued на диске (задача завершена/удалена/устарела).
 * @returns {Promise<{ accountId: string, taskId: string, moduleKey: string }[]>}
 */
export async function reconcileLocks() {
  if (!locks.size) return []
  /** @type {{ accountId: string, taskId: string, moduleKey: string }[]} */
  const dropped = []
  for (const [accountId, lock] of [...locks]) {
    // Многомодульность: проверяем КАЖДОГО держателя — стухнуть может и второй,
    // пока первый честно работает.
    const alive = []
    for (const h of lock.holders) {
      if (isTaskLive(h.taskId)) { alive.push(h); continue }
      const status = await findTaskStatus(h.taskId)
      // paused — задача жива и держит аккаунты зарезервированными (возобновится с ними же).
      if (status === 'running' || status === 'queued' || status === 'paused') { alive.push(h); continue }
      dropped.push({ accountId, taskId: h.taskId, moduleKey: h.moduleKey })
    }
    if (!alive.length) locks.delete(accountId)
    else if (alive.length !== lock.holders.length) locks.set(accountId, packHolders(alive))
  }
  return dropped
}

/**
 * Согласование на старте API. Воркеры живут только в памяти процесса, поэтому
 * после перезапуска ни один «running/queued» таск на диске уже не выполняется.
 *
 * Раньше такие задачи помечались `stopped` — то есть любой деплой убивал всю активную
 * работу, и оператор поднимал каждую задачу руками. На тысяче пользователей это авария
 * при каждой выкатке. Теперь они переводятся в ПАУЗУ с пометкой `resumeOnBoot`, а
 * `resumeMarkedTasks()` поднимает их сразу после согласования: прогресс, actionKeys и
 * курсоры и так лежат на диске, локи перезахватываются штатным «Возобновить».
 *
 * Блокировки здесь по-прежнему НЕ восстанавливаем: их возьмёт заново сам resume, а до
 * него аккаунт не должен числиться «в работе» без единого воркера.
 * @returns {Promise<{ flipped: string[] }>}
 */
export async function reconcileStaleTasksOnBoot() {
  locks.clear()
  liveTasks.clear()
  /** @type {string[]} */
  const flipped = []

  const flipStale = async (full, store) => {
    // Пауза, а не стоп: паузу умеет отменять `resumeModuleTask`, и она не считается
    // решением человека — значит задачу законно поднять автоматически.
    full.status = 'paused'
    full.pauseRequested = true
    full.stopRequested = false
    full.resumeOnBoot = true
    full.interruptedAt = Date.now()
    if (typeof store.appendLog === 'function') {
      await store.appendLog(full, 'warning', 'Прервана перезапуском сервиса — будет восстановлена автоматически')
    } else {
      await store.saveTask(full)
    }
    flipped.push(full.id)
  }

  try {
    const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const tasks = await store.listTasks()
      for (const t of tasks) {
        if (t.status !== 'running' && t.status !== 'queued') continue
        const full = await store.loadTask(t.id)
        if (!full) continue
        await flipStale(full, store)
      }
    }
  } catch { /* ignore */ }

  try {
    const ncStore = await import('../neuroCommenting/taskStore.js')
    const tasks = await ncStore.listTasks()
    for (const t of tasks) {
      if (t.status !== 'running' && t.status !== 'queued') continue
      const full = await ncStore.loadTask(t.id)
      if (!full) continue
      await flipStale(full, ncStore)
    }
  } catch { /* ignore */ }

  // Аккаунты, зависшие в «working». Воркеры пишут этот статус напрямую при старте и
  // снимают в конце — при падении процесса снимать некому, и аккаунт навсегда остаётся
  // «В работе»: локов нет, задач нет, а менеджер и счётчик дашборда показывают занятость.
  // Штатно это не лечилось вообще (прогон 21–22.07, тест 12.11): `locks/reconcile`
  // возвращал dropped: [], а `POST /accounts/:id/status {to:'active'}` отвечал ok:true
  // и НИЧЕГО не делал — потому что LEGACY_MAP.working = ACTIVE, переход считался
  // «active→active» и setAccountStatus молча выходил. Снимаем здесь, сырым патчем.
  const cleared = []
  // Аккаунты задач прогрева, которые стоят НА ПАУЗЕ, — их статус трогать нельзя.
  const pausedWarming = new Set()
  try {
    const { getModuleStore } = await import('../modules/registry.js')
    const store = getModuleStore('warming')
    for (const t of store ? await store.listTasks() : []) {
      if (t.status !== 'paused') continue
      const full = await store.loadTask(t.id)
      for (const id of full?.settings?.accountIds || []) pausedWarming.add(id)
    }
  } catch { /* ignore */ }
  try {
    const { loadAllMeta, setAccountMeta } = await import('../accountsMeta.js')
    const all = await loadAllMeta()
    for (const [id, meta] of Object.entries(all)) {
      // 'working' — всегда мусор после падения: живых воркеров уже нет.
      // 'warming' — тоже, но только если аккаунт не ждёт ПРОДОЛЖЕНИЯ прогрева: задачи
      // на паузе переживают рестарт, и снимать у них статус нельзя, иначе аккаунт
      // посреди прогрева уйдёт в боевые модули. Иначе он завис бы навсегда вне боя —
      // ровно та же болезнь, что была у 'working' (найдено аудитом собственных правок 22.07).
      const stuck = meta?.status === 'working' || (meta?.status === 'warming' && !pausedWarming.has(id))
      if (!stuck) continue
      await setAccountMeta(id, { status: 'active', statusBefore: null })
      cleared.push(id)
    }
  } catch { /* ignore */ }

  return { flipped, cleared }
}
