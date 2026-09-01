/**
 * Хранилище задач модулей.
 *
 * ─── MR-290: ЗАДАЧИ ПЕРЕЕХАЛИ В БАЗУ ───
 *
 * Раньше задача была файлом `server/data/modules/<модуль>/tasks/<id>.json`, и внутри
 * лежало всё сразу: настройки, прогресс, до 500 строк журнала, история, результаты,
 * статистика по аккаунтам и ключи выполненных действий. Отсюда три беды: второй инстанс
 * видел ДРУГИЕ задачи; дашборд читал все файлы целиком, чтобы показать десяток строк; а
 * каждая строка журнала означала перезапись всего файла (`appendLog` звал `saveTask`).
 *
 * ВНЕШНИЙ API НЕ ИЗМЕНИЛСЯ намеренно. `saveTask`, `appendLog`, `appendHistory` вызываются
 * из воркеров в сотнях мест, и менять форму объекта задачи значило бы править их все —
 * то есть менять поведение движка ради формы хранения. Объект задачи в памяти прежний,
 * изменилось только то, куда он ложится.
 *
 * Что теперь происходит при записи:
 *   • `appendLog` вставляет ОДНУ строку журнала, а не переписывает задачу целиком;
 *   • `saveTask` дописывает только НОВОЕ — результаты и ключи действий, появившиеся с
 *     прошлого сохранения, и обновляет статистику по аккаунтам;
 *   • список задач берётся из представления `task_list`: счётчики ошибок и флудвейтов
 *     считает база, иначе список снова стал бы запросом на задачу.
 *
 * Файловый режим сохранён полностью: без `DATA_BACKEND=supabase` (тесты, локальный
 * запуск) всё работает по-старому, файл в файл.
 */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { resolveTotalTarget } from './targets.js'
import { fileURLToPath } from 'url'
import { getSupabase, supabaseEnabled, isMissingTable } from './supabase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Тот же корень, что у остальных хранилищ (jsonStore.DATA_DIR): переопределяется через
// DATA_DIR, и тесты пишут задачи к себе во временный каталог, а не в боевой server/data.
// Раньше путь был зашит намертво — и `npm test` засорял дашборд задачами с `acc_test_1`.
const DATA_ROOT = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'modules')

const LOG_LIMIT = 500
const HISTORY_LIMIT = 200

/*
 * Клиент базы. Вынесен в функцию с возможностью подмены, потому что иначе ветка «пишем в
 * базу» не покрывается ничем: тесты гоняются на файловом хранилище, а поднимать Postgres
 * ради проверки того, что задача правильно раскладывается по пяти таблицам, — дороже, чем
 * сама проверка. Подмена нужна только тестам; боевой код третьего аргумента не передаёт.
 */
function taskDb(deps) { return deps?.db ? deps.db() : (supabaseEnabled() ? getSupabase() : null) }

const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString()
const msOf = (v) => (v ? new Date(v).getTime() : 0)

/**
 * Скрытая отметка «что уже сохранено».
 *
 * Результаты и ключи действий воркер ДОПИСЫВАЕТ в массив, а не пересобирает, поэтому
 * сохранять надо только хвост — иначе каждое сохранение переливало бы всю выгрузку
 * заново. Отметка неперечислимая: она не должна попасть ни в DTO, ни в json, ни в
 * `settings`. Если объект задачи пересоздали (перезапуск воркера), отметка сбросится —
 * и запись просто пройдёт повторно, но ничего не задвоит: у обеих таблиц составной
 * первичный ключ, вставка идёт `on conflict do nothing`.
 */
function persisted(task) {
  if (!Object.prototype.hasOwnProperty.call(task, '__persisted')) {
    Object.defineProperty(task, '__persisted', {
      value: { results: 0, actionKeys: 0, seq: Object.create(null) },
      enumerable: false, writable: true, configurable: true,
    })
  }
  return task.__persisted
}

/** @param {string} moduleKey @param {string} idPrefix */
export function createTaskStore(moduleKey, idPrefix, deps = {}) {
  const baseDir = path.join(DATA_ROOT, moduleKey)
  const tasksDir = path.join(baseDir, 'tasks')
  const presetsFile = path.join(baseDir, 'presets.json')

  async function ensureDirs() {
    await fs.mkdir(tasksDir, { recursive: true })
  }

  function newTaskId() {
    return `${idPrefix}_${crypto.randomUUID().slice(0, 8)}`
  }

  function newLogId() {
    return crypto.randomUUID().slice(0, 8)
  }

  function taskPath(taskId) {
    return path.join(tasksDir, `${taskId}.json`)
  }

  // ── База: перевод задачи в строку и обратно ───────────────────────────────

  const taskToRow = (task) => ({
    id: task.id,
    module_key: moduleKey,
    status: task.status || 'queued',
    initiator: task.initiator || null,
    user_id: task.userId || null,
    goal_id: task.goalId ?? task.settings?.goalId ?? null,
    campaign_id: task.campaignId ?? null,
    settings: task.settings || {},
    progress_done: Number(task.progress?.done) || 0,
    progress_total: Number(task.progress?.total) || 0,
    progress_actions: Number(task.progress?.actionsDone) || 0,
    spent_coins: Number(task.spentCoins) || 0,
    stop_requested: !!task.stopRequested,
    pause_requested: !!task.pauseRequested,
    resume_on_boot: !!task.resumeOnBoot,
    fatal_error: task.fatalError || null,
    created_at: iso(task.createdAt),
    updated_at: iso(task.updatedAt),
  })

  const rowToTask = (r) => ({
    id: r.id,
    moduleKey,
    status: r.status,
    initiator: r.initiator || null,
    userId: r.user_id || '',
    goalId: r.goal_id ?? null,
    campaignId: r.campaign_id ?? null,
    settings: r.settings || {},
    progress: { done: r.progress_done || 0, total: r.progress_total || 0, actionsDone: r.progress_actions || 0 },
    spentCoins: Number(r.spent_coins) || 0,
    stopRequested: !!r.stop_requested,
    pauseRequested: !!r.pause_requested,
    resumeOnBoot: !!r.resume_on_boot,
    fatalError: r.fatal_error || '',
    createdAt: msOf(r.created_at),
    updatedAt: msOf(r.updated_at),
    logs: [], history: [], results: [], accountStats: {}, actionKeys: [],
  })

  /**
   * Вставка задачи с мягким откатом по ССЫЛКАМ.
   *
   * У задачи три внешних ключа — владелец, цель, кампания. Любой из них может к моменту
   * запуска исчезнуть (цель удалили, пока оператор выбирал модуль). Ронять из-за этого
   * запуск нельзя: работа важнее атрибуции. Но и молчать нельзя — иначе задача тихо
   * теряет связь, а найти это потом невозможно. Поэтому: снимаем ровно ту ссылку, на
   * которую ругается база, говорим об этом КАЖДЫЙ раз и повторяем.
   */
  async function upsertTask(db, row) {
    const { error } = await db.from('tasks').upsert(row, { onConflict: 'id' })
    if (!error) return
    const blob = `${error.message || ''} ${error.details || ''}`
    if (String(error.code) !== '23503') throw new Error(`[tasks] задача ${row.id} не сохранена: ${error.message}`)
    const dropped = ['user_id', 'goal_id', 'campaign_id'].filter((c) => blob.includes(c))
    if (!dropped.length) throw new Error(`[tasks] задача ${row.id} не сохранена: ${error.message}`)
    const retry = { ...row }
    for (const c of dropped) retry[c] = null
    console.warn(`[tasks] ${row.id}: ссылка(и) ${dropped.join(', ')} ведут в никуда — задача сохранена без них. Объект, на который ссылались, удалён.`)
    const again = await db.from('tasks').upsert(retry, { onConflict: 'id' })
    if (again.error) throw new Error(`[tasks] задача ${row.id} не сохранена: ${again.error.message}`)
  }

  /** Дописать хвост списка: только то, чего ещё нет в базе. */
  async function appendTail(db, table, rows) {
    if (!rows.length) return
    const { error } = await db.from(table).upsert(rows, { ignoreDuplicates: true })
    if (error && !isMissingTable(error)) throw new Error(`[${table}] не удалось дописать: ${error.message}`)
  }

  async function saveTaskDb(db, task, opts) {
    if (!opts.control) {
      /*
       * Флаги управления и фатальная ошибка выставляются ИЗВНЕ (кнопка «Стоп», «Пауза»,
       * падение), и обычное сохранение воркера не должно их стирать: гонка §3.9. Читаем
       * текущее состояние и «дожимаем» его в сохраняемое.
       */
      const { data: prev } = await db.from('tasks')
        .select('stop_requested, pause_requested, fatal_error').eq('id', task.id).maybeSingle()
      if (prev?.stop_requested) task.stopRequested = true
      if (prev?.pause_requested) task.pauseRequested = true
      if (prev?.fatal_error && !task.fatalError) task.fatalError = prev.fatal_error
    }

    await upsertTask(db, taskToRow(task))

    const mark = persisted(task)
    const results = task.results || []
    if (results.length > mark.results) {
      await appendTail(db, 'task_events', results.slice(mark.results).map((payload, i) => ({
        task_id: task.id, field: 'result', position: mark.results + i, payload: payload ?? {},
      })))
      mark.results = results.length
    }

    const keys = task.actionKeys || []
    if (keys.length > mark.actionKeys) {
      await appendTail(db, 'task_action_keys',
        keys.slice(mark.actionKeys).map((key) => ({ task_id: task.id, key: String(key) })))
      mark.actionKeys = keys.length
    }

    const stats = Object.entries(task.accountStats || {})
    if (stats.length) {
      // Статистика МЕНЯЕТСЯ (счётчики растут), поэтому здесь upsert с перезаписью, а не
      // «дописать хвост». Строк тут единицы — по числу аккаунтов задачи.
      const { error } = await db.from('task_account_stats').upsert(
        stats.map(([accountId, s]) => ({
          task_id: task.id,
          account_id: accountId,
          actions: Number(s?.actions) || 0,
          flood_waits: Number(s?.floodWaits) || 0,
          data: s || {},
        })), { onConflict: 'task_id,account_id' })
      if (error && !isMissingTable(error)) {
        // Аккаунт мог быть удалён — статистика по нему не повод ронять задачу.
        console.warn(`[task_account_stats] ${task.id}: статистика не сохранена — ${error.message}`)
      }
    }
  }

  /**
   * @param {object} task
   * @param {{ control?: boolean }} [opts] control:true — операция управления (resume и т.п.),
   *   которой РАЗРЕШЕНО сбрасывать флаги stop/pause. Обычные сохранения воркера (прогресс,
   *   логи) НЕ должны затирать выставленные извне stopRequested/pauseRequested (гонка §3.9).
   */
  async function saveTask(task, opts = {}) {
    task.updatedAt = Date.now()
    task.moduleKey = moduleKey
    const db = taskDb(deps)
    if (db) return saveTaskDb(db, task, opts)

    await ensureDirs()
    if (!opts.control) {
      try {
        const prev = JSON.parse(await fs.readFile(taskPath(task.id), 'utf8'))
        if (prev.stopRequested) task.stopRequested = true
        if (prev.pauseRequested) task.pauseRequested = true
        // Фатальная ошибка — такой же «внешний» флаг: побочная запись лога не должна
        // её стирать, иначе задача снова оказывается «готовой» вместо упавшей.
        if (prev.fatalError && !task.fatalError) task.fatalError = prev.fatalError
      } catch { /* нет файла — первая запись */ }
    }
    await fs.writeFile(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8')
  }

  /**
   * Починка знаменателя прогресса у задач, СОЗДАННЫХ РАНЬШЕ правки.
   *
   * Цель задачи — случайная в [min, max] и детерминирована по её id, а в `progress.total`
   * писался максимум диапазона. Из-за этого задача с целью 9 при maxActions=10 честно
   * доходила до конца, вставала как «Готово», но полоса показывала 9/10 = 90%.
   * Пересчитываем ТУ ЖЕ функцию, по которой воркер решал «хватит» — значение совпадает
   * с тем, что реально было целью. Только для чтения: хранилище не переписываем.
   * @param {object} task
   */
  function withRealTarget(task) {
    if (!task?.progress || !task.settings) return task
    const byDuration = task.settings.workMode === 1 && task.settings.durationMinutes
    if (byDuration) return task // режим «по времени» — счётчик действий не показателен
    // Лимита действий у задачи может не быть вовсе: у AI Rating объём — это число
    // аккаунтов, у мейлинга и автопостинга — длина списка целей. Для них
    // `resolveTotalTarget` подставляет свой дефолт (100) и выдаёт случайное число из
    // диапазона — живой прогон 17.08 показал «6/35» там, где проверено 6 аккаунтов из 6.
    // Уточнять знаменатель имеет смысл, только если лимит реально задан.
    const s = task.settings
    const hasLimit = [s.maxActions, s.maxComments, s.minActions, s.minComments]
      .some((v) => v !== undefined && v !== null && v !== '')
    if (!hasLimit) return task
    try {
      const target = resolveTotalTarget(task.settings, task)
      if (target > 0 && task.progress.total !== target) {
        return { ...task, progress: { ...task.progress, total: target } }
      }
    } catch { /* не смогли уточнить — оставляем как есть */ }
    return task
  }

  /** @param {string} taskId */
  async function loadTask(taskId) {
    const db = taskDb(deps)
    if (db) {
      const { data: row, error } = await db.from('tasks').select('*').eq('id', taskId).maybeSingle()
      if (error || !row) return null
      const [logs, events, stats, keys] = await Promise.all([
        // По сквозному номеру, а не по времени: у времени миллисекундная точность, и
        // две строки в одну миллисекунду встали бы в произвольном порядке.
        db.from('task_logs').select('*').eq('task_id', taskId).order('seq', { ascending: false }).limit(LOG_LIMIT),
        db.from('task_events').select('*').eq('task_id', taskId).order('position', { ascending: true }),
        db.from('task_account_stats').select('*').eq('task_id', taskId),
        db.from('task_action_keys').select('key').eq('task_id', taskId),
      ])
      const task = rowToTask(row)
      task.logs = (logs.data || []).map((l) => ({
        id: l.entry_id, ts: l.ts, level: l.level, message: l.message,
        module: l.module_key || moduleKey, initiator: l.initiator || 'system',
        ...(l.account_id ? { account: l.account_id } : {}),
        ...(l.code ? { code: l.code } : {}),
        ...(l.reason ? { reason: l.reason } : {}),
      }))
      const mark = persisted(task)
      for (const e of events.data || []) {
        if (e.field === 'result') task.results.push(e.payload)
        else {
          // История хранится в порядке добавления, а в памяти живёт «свежее сверху».
          (task[e.field] ||= []).unshift(e.payload)
          mark.seq[e.field] = Math.max(mark.seq[e.field] || 0, e.position + 1)
        }
      }
      for (const s of stats.data || []) {
        task.accountStats[s.account_id] = { ...(s.data || {}), actions: s.actions, floodWaits: s.flood_waits }
      }
      task.actionKeys = (keys.data || []).map((k) => k.key)
      mark.results = task.results.length
      mark.actionKeys = task.actionKeys.length
      return withRealTarget(task)
    }
    try {
      const raw = await fs.readFile(taskPath(taskId), 'utf8')
      return withRealTarget(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** Строка списка — та же форма, что отдавалась из файлов. */
  const listRow = (r) => withRealTarget({
    id: r.id,
    moduleKey,
    status: r.status,
    initiator: r.initiator || null,
    // Владелец нужен фильтру «свои задачи» (§8.1): без него дашборд не сможет
    // отличить чужой запуск от своего и покажет либо всё, либо ничего.
    userId: r.user_id || '',
    spentCoins: Number(r.spent_coins) || 0, // §5.1: во сколько обошёлся ЭТОТ запуск
    // Счётчик ошибок — не сами логи: админке нужно «где болит», не таща в список
    // весь журнал каждой задачи. Считает база (представление task_list).
    errors: r.error_count || 0,
    lastError: r.last_error || '',
    // Причина ПАДЕНИЯ отдельно от «последней строки с ошибкой»: у задачи могут
    // быть рабочие ошибки по отдельным аккаунтам, и в карточке нужно показывать то,
    // из-за чего задача встала, а не последнюю жалобу.
    fatalError: r.fatal_error || '',
    // Пауза из-за денег отличается от паузы рукой: первую чинит пополнение.
    // Ищем ТОЧНУЮ фразу и только в последней записи: широкий поиск «монет|баланс»
    // по всему журналу ловил и строку возврата «Возврат N монет», из-за чего
    // задача, поставленная на паузу рукой, показывалась как «ждёт пополнения».
    pausedByCoins: r.status === 'paused' && /Закончились монеты/i.test(String(r.last_message || '')),
    // MR-134: сколько FloodWait поймали аккаунты этой задачи — сигнал «упираемся в лимиты».
    floodWaits: r.flood_waits || 0,
    goalId: r.goal_id ?? r.settings?.goalId ?? null,
    campaignId: r.campaign_id ?? null,
    createdAt: msOf(r.created_at),
    updatedAt: msOf(r.updated_at),
    progress: { done: r.progress_done || 0, total: r.progress_total || 0, actionsDone: r.progress_actions || 0 },
    settings: r.settings || {},
  })

  async function listTasks() {
    const db = taskDb(deps)
    if (db) {
      const { data, error } = await db.from('task_list').select('*')
        .eq('module_key', moduleKey).order('created_at', { ascending: false })
      if (error) {
        if (!isMissingTable(error)) throw new Error(`[task_list] список задач не прочитан: ${error.message}`)
        return [] // миграция не доехала — пусто лучше, чем падение страницы
      }
      return (data || []).map(listRow)
    }
    await ensureDirs()
    const files = await fs.readdir(tasksDir)
    const tasks = []
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(tasksDir, f), 'utf8')
        const t = withRealTarget(JSON.parse(raw))
        tasks.push({
          id: t.id,
          moduleKey,
          status: t.status,
          initiator: t.initiator || null,
          userId: t.userId || '',
          spentCoins: t.spentCoins || 0,
          errors: (t.logs || []).reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0),
          lastError: (t.logs || []).find((l) => l.level === 'error')?.message || '',
          fatalError: t.fatalError || '',
          pausedByCoins: t.status === 'paused'
            && /Закончились монеты/i.test(String((t.logs || [])[0]?.message || '')),
          floodWaits: Object.values(t.accountStats || {}).reduce((n, s) => n + (Number(s?.floodWaits) || 0), 0),
          goalId: t.goalId ?? t.settings?.goalId ?? null,
          campaignId: t.campaignId ?? null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          progress: t.progress,
          settings: t.settings,
        })
      } catch {
        /* skip */
      }
    }
    tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return tasks
  }

  /**
   * @param {object} task @param {'info'|'success'|'warning'|'error'} level @param {string} message
   * @param {string} [account] @param {{ code?: string, reason?: string }} [opts]
   * Поля Фазы 0 (§3.1): `module`/`initiator`/`ts` берём из контекста задачи, `code`/`reason` — опц.
   */
  async function appendLog(task, level, message, account, opts = {}) {
    const entry = {
      id: newLogId(),
      ts: new Date().toISOString(),
      level,
      message,
      module: task.moduleKey,              // из какого модуля (Фаза 0)
      initiator: task.initiator || 'system', // кто инициировал задачу (Фаза 0)
      ...(account ? { account } : {}),
      ...(opts.code ? { code: String(opts.code) } : {}),      // машинный код события
      ...(opts.reason ? { reason: String(opts.reason) } : {}), // причина
    }
    task.logs = task.logs || []
    task.logs.unshift(entry)
    if (task.logs.length > LOG_LIMIT) task.logs.length = LOG_LIMIT

    const db = taskDb(deps)
    if (db) {
      // Одна строка вместо перезаписи всей задачи. Задачу всё равно сохраняем следом:
      // вызывающие часто меняют статус или прогресс прямо перед записью в журнал, и
      // прежний appendLog это сохранял — поведение оставляем прежним.
      await saveTask(task)
      const { error } = await db.from('task_logs').upsert({
        task_id: task.id, entry_id: entry.id, ts: entry.ts, level, message: message || '',
        account_id: account || null, module_key: task.moduleKey || moduleKey,
        initiator: entry.initiator, code: opts.code || null, reason: opts.reason || null,
      }, { ignoreDuplicates: true })
      if (error && !isMissingTable(error)) throw new Error(`[task_logs] строка журнала не сохранена: ${error.message}`)
      return entry
    }
    await saveTask(task)
    return entry
  }

  /** @param {object} task @param {object} item @param {string} [field='history'] */
  async function appendHistory(task, item, field = 'history') {
    task[field] = task[field] || []
    task[field].unshift(item)
    if (task[field].length > HISTORY_LIMIT) task[field].length = HISTORY_LIMIT

    const db = taskDb(deps)
    if (db) {
      const mark = persisted(task)
      const position = mark.seq[field] || 0
      mark.seq[field] = position + 1
      await saveTask(task)
      const { error } = await db.from('task_events').upsert(
        { task_id: task.id, field, position, payload: item ?? {} }, { ignoreDuplicates: true })
      if (error && !isMissingTable(error)) throw new Error(`[task_events] запись истории не сохранена: ${error.message}`)
      return
    }
    await saveTask(task)
  }

  /** @param {object} settings @param {object} [init] */
  function createTask(settings, init = {}) {
    return {
      id: newTaskId(),
      moduleKey,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stopRequested: false,
      settings,
      progress: init.progress ?? { done: 0, total: settings.maxActions ?? 100, actionsDone: 0 },
      logs: [],
      history: [],
      results: [],
      accountStats: {},
      actionKeys: [],
      ...init,
    }
  }

  /** Чтение/запись файла — фолбэк для локального запуска и тестов (без DATA_BACKEND). */
  async function readPresetsFile() {
    try {
      const raw = await fs.readFile(presetsFile, 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }
  async function writePresetsFile(presets) {
    await ensureDirs()
    await fs.writeFile(presetsFile, JSON.stringify(presets, null, 2), 'utf8')
  }

  /*
   * Переноса файловых шаблонов в базу здесь НЕТ намеренно.
   *
   * Сначала он был автоматическим — при первом чтении модуля. Но локальные копии
   * разработчиков ходят в ту же боевую базу, а файлы у всех разные: чья копия прочитала
   * первой, того шаблоны и уехали бы в прод, а настоящие серверные — уже нет (таблица
   * непустая, перенос считается сделанным). Это лотерея с чужими данными.
   *
   * Перенос делается осознанно и на сервере: `node server/scripts/presets-to-db.mjs`.
   */
  async function loadPresets() {
    const { loadModulePresets } = await import('../modulePresets.js')
    return loadModulePresets(moduleKey, readPresetsFile)
  }

  /** @param {object[]} presets */
  async function savePresets(presets) {
    const { saveModulePresets } = await import('../modulePresets.js')
    return saveModulePresets(moduleKey, presets, writePresetsFile)
  }

  /** @param {object} task */
  function taskToDto(task) {
    return {
      id: task.id,
      moduleKey: task.moduleKey || moduleKey,
      status: task.status,
      initiator: task.initiator || null,
      userId: task.userId || '',
      spentCoins: task.spentCoins || 0,
      goalId: task.goalId ?? task.settings?.goalId ?? null,
      campaignId: task.campaignId ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      progress: task.progress,
      settings: task.settings,
      logs: task.logs || [],
      history: task.history || [],
      commentHistory: task.commentHistory || task.history || [],
      results: task.results || [],
      accountStats: task.accountStats || {},
    }
  }

  return {
    moduleKey,
    saveTask,
    loadTask,
    listTasks,
    appendLog,
    appendHistory,
    createTask,
    loadPresets,
    savePresets,
    taskToDto,
  }
}
