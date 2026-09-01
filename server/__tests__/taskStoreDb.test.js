/**
 * MR-290: задачи модулей в базе. Проверяется ветка «пишем в Postgres».
 *
 * Обычные тесты стора гоняют файловый режим — в нём ошибка раскладки по таблицам не видна
 * вовсе. А цена её высокая: задача — ядро платформы, и потеря журнала или задвоение
 * результатов обнаружились бы уже на боевой, по жалобе.
 *
 * Поднимать Postgres ради этого дороже самой проверки, поэтому здесь поддельный клиент:
 * он хранит строки в памяти и соблюдает главное свойство настоящего — составные первичные
 * ключи и `on conflict do nothing`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskStore } from '../lib/taskStore.js'

/** Составные ключи таблиц — от них зависит, дублируется запись или нет. */
const KEYS = {
  tasks: ['id'],
  task_logs: ['task_id', 'entry_id'],
  task_events: ['task_id', 'field', 'position'],
  task_account_stats: ['task_id', 'account_id'],
  task_action_keys: ['task_id', 'key'],
}

function fakeDb({ failOn } = {}) {
  const tables = new Map()
  const rowsOf = (t) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t) }
  let seqCounter = 0
  const keyOf = (t, r) => (KEYS[t] || ['id']).map((k) => String(r[k])).join('|')

  /** Витрина task_list — то же, что делает представление в базе. */
  function taskList() {
    return rowsOf('tasks').map((t) => {
      // По сквозному номеру, как и представление в базе: время до миллисекунды у двух
      // соседних строк совпадает, и сортировка по нему давала бы случайный порядок.
      const logs = rowsOf('task_logs').filter((l) => l.task_id === t.id).sort((a, b) => b.seq - a.seq)
      const stats = rowsOf('task_account_stats').filter((s) => s.task_id === t.id)
      return {
        ...t,
        error_count: logs.filter((l) => l.level === 'error').length,
        last_error: logs.find((l) => l.level === 'error')?.message ?? null,
        last_message: logs[0]?.message ?? null,
        flood_waits: stats.reduce((n, s) => n + (s.flood_waits || 0), 0),
      }
    })
  }

  function builder(table) {
    const filters = []
    let ordering = null
    let take = null
    let single = false
    const q = {
      select() { return q },
      eq(col, val) { filters.push([col, val]); return q },
      order(col, opt) { ordering = [col, opt?.ascending !== false]; return q },
      limit(n) { take = n; return q },
      maybeSingle() { single = true; return q },
      upsert(rows, opts = {}) {
        if (failOn?.table === table) return Promise.resolve({ error: failOn.error })
        const list = Array.isArray(rows) ? rows : [rows]
        const store = rowsOf(table)
        for (const r of list) {
          const k = keyOf(table, r)
          const i = store.findIndex((x) => keyOf(table, x) === k)
          // `seq` в базе — identity: сквозной номер, дающий строгий порядок даже когда
          // время совпало до миллисекунды.
          if (i === -1) store.push({ ...r, seq: ++seqCounter })
          else if (!opts.ignoreDuplicates) store[i] = { ...store[i], ...r }
        }
        return Promise.resolve({ error: null })
      },
      then(res, rej) {
        let out = (table === 'task_list' ? taskList() : rowsOf(table))
          .filter((r) => filters.every(([c, v]) => r[c] === v))
        if (ordering) {
          const [c, asc] = ordering
          out = [...out].sort((a, b) => {
            const x = a[c]; const y = b[c]
            const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : (String(x) > String(y) ? 1 : String(x) < String(y) ? -1 : 0)
            return cmp * (asc ? 1 : -1)
          })
        }
        if (take != null) out = out.slice(0, take)
        return Promise.resolve(single ? { data: out[0] ?? null, error: null } : { data: out, error: null }).then(res, rej)
      },
    }
    return q
  }
  return { from: builder, rows: (t) => rowsOf(t) }
}

const storeOn = (db) => createTaskStore('warming', 'wrm', { db: () => db })

test('saveTask кладёт задачу строкой и не трогает журнал', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({ maxActions: 7, goalId: 'goal_1' }, { userId: 'usr_1', initiator: 'operator' })
  task.progress = { done: 2, total: 7, actionsDone: 3 }
  await store.saveTask(task)

  const [row] = db.rows('tasks')
  assert.equal(row.id, task.id)
  assert.equal(row.module_key, 'warming')
  assert.equal(row.status, 'queued')
  assert.equal(row.user_id, 'usr_1')
  assert.equal(row.goal_id, 'goal_1', 'цель берётся из настроек, если не задана явно')
  assert.equal(row.progress_done, 2)
  assert.equal(row.progress_actions, 3)
  assert.deepEqual(row.settings, { maxActions: 7, goalId: 'goal_1' })
  assert.equal(db.rows('task_logs').length, 0, 'журнал пишется отдельно, а не вместе с задачей')
})

test('appendLog вставляет ОДНУ строку, повтор той же не дублирует', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  await store.saveTask(task)

  const entry = await store.appendLog(task, 'error', 'аккаунт улетел в бан', 'acc_1', { code: 'BANNED' })
  assert.equal(db.rows('task_logs').length, 1)
  const [log] = db.rows('task_logs')
  assert.equal(log.level, 'error')
  assert.equal(log.account_id, 'acc_1')
  assert.equal(log.code, 'BANNED')
  assert.equal(log.entry_id, entry.id)

  // Повторное сохранение той же строки (перезапуск воркера) не должно её задваивать:
  // первичный ключ (задача, запись) + on conflict do nothing.
  await db.from('task_logs').upsert({ task_id: task.id, entry_id: entry.id, level: 'error', message: 'другой текст' }, { ignoreDuplicates: true })
  assert.equal(db.rows('task_logs').length, 1)
  assert.equal(db.rows('task_logs')[0].message, 'аккаунт улетел в бан', 'повтор не перезаписывает')
})

test('saveTask дописывает только хвост результатов и ключей действий', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  task.results.push({ n: 1 }, { n: 2 })
  task.actionKeys.push('k1', 'k2')
  await store.saveTask(task)
  assert.equal(db.rows('task_events').length, 2)
  assert.equal(db.rows('task_action_keys').length, 2)

  // Второе сохранение без новых элементов не должно ничего добавлять — иначе каждое
  // сохранение переливало бы всю выгрузку заново.
  await store.saveTask(task)
  assert.equal(db.rows('task_events').length, 2, 'повторное сохранение не дублирует')

  task.results.push({ n: 3 })
  task.actionKeys.push('k3')
  await store.saveTask(task)
  assert.equal(db.rows('task_events').length, 3)
  assert.deepEqual(db.rows('task_events').map((e) => e.position), [0, 1, 2], 'позиции идут подряд')
  assert.equal(db.rows('task_action_keys').length, 3)
})

test('обычное сохранение НЕ затирает стоп и паузу, control:true — сбрасывает', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  await store.saveTask(task)

  // Кнопка «Стоп» снаружи.
  db.rows('tasks')[0].stop_requested = true
  db.rows('tasks')[0].fatal_error = 'упало'

  // Воркер сохраняет прогресс, ничего не зная о стопе (гонка §3.9).
  const worker = { ...task, stopRequested: false, fatalError: '' }
  await store.saveTask(worker)
  assert.equal(db.rows('tasks')[0].stop_requested, true, 'стоп переживает сохранение воркера')
  assert.equal(db.rows('tasks')[0].fatal_error, 'упало', 'причина падения не стирается логом')

  // Возобновление — операция управления: ей сбрасывать флаги можно.
  await store.saveTask({ ...task, stopRequested: false, fatalError: '' }, { control: true })
  assert.equal(db.rows('tasks')[0].stop_requested, false)
})

test('loadTask собирает задачу обратно целиком', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({ maxActions: 3 }, { userId: 'usr_1' })
  task.accountStats.acc_1 = { actions: 5, floodWaits: 2 }
  task.results.push({ found: 'a' })
  task.actionKeys.push('k1')
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'начали')
  await store.appendHistory(task, { step: 1 })
  await store.appendHistory(task, { step: 2 })

  const back = await store.loadTask(task.id)
  assert.equal(back.id, task.id)
  assert.equal(back.userId, 'usr_1')
  assert.equal(back.logs.length, 1)
  assert.deepEqual(back.results, [{ found: 'a' }])
  assert.deepEqual(back.actionKeys, ['k1'])
  assert.deepEqual(back.accountStats.acc_1, { actions: 5, floodWaits: 2 })
  assert.deepEqual(back.history[0], { step: 2 }, 'история отдаётся свежим сверху, как и раньше')

  // Дозапись после чтения не дублирует уже сохранённое: отметка восстановилась.
  back.results.push({ found: 'b' })
  await store.saveTask(back)
  assert.equal(db.rows('task_events').filter((e) => e.field === 'result').length, 2)
})

test('listTasks берёт счётчики из витрины, а не считает журналы сам', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  task.accountStats.acc_1 = { actions: 1, floodWaits: 4 }
  await store.saveTask(task)
  await store.appendLog(task, 'error', 'первая беда')
  await store.appendLog(task, 'info', 'работаем')

  const [row] = await store.listTasks()
  assert.equal(row.errors, 1)
  assert.equal(row.lastError, 'первая беда')
  assert.equal(row.floodWaits, 4)
  assert.equal(row.logs, undefined, 'в списке журналов быть не должно — за ними идут в карточку')
})

test('«ждёт пополнения» определяется по ПОСЛЕДНЕЙ строке журнала', async () => {
  // Широкий поиск по всему журналу ловил и строку возврата монет, из-за чего задача,
  // остановленная рукой, показывалась как «ждёт пополнения».
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  task.status = 'paused'
  await store.saveTask(task)
  await store.appendLog(task, 'warning', 'Закончились монеты')
  assert.equal((await store.listTasks())[0].pausedByCoins, true)

  await store.appendLog(task, 'info', 'Возврат 5 монет')
  assert.equal((await store.listTasks())[0].pausedByCoins, false, 'возврат монет — не причина паузы')
})

test('битая ссылка снимается, а задача сохраняется', async () => {
  // Цель могли удалить, пока оператор выбирал модуль. Ронять из-за этого запуск нельзя,
  // но и молча терять связь — тоже: сообщение обязано быть.
  let attempt = 0
  const db = fakeDb()
  const real = db.from
  db.from = (table) => {
    const q = real(table)
    if (table !== 'tasks') return q
    const upsert = q.upsert
    q.upsert = (rows, opts) => {
      attempt++
      if (attempt === 1) return Promise.resolve({ error: { code: '23503', message: 'violates foreign key constraint', details: 'Key (goal_id)=(goal_x) is not present' } })
      return upsert(rows, opts)
    }
    return q
  }
  const store = storeOn(db)
  const task = store.createTask({ goalId: 'goal_x' })
  await store.saveTask(task)
  assert.equal(db.rows('tasks').length, 1, 'задача всё равно сохранена')
  assert.equal(db.rows('tasks')[0].goal_id, null, 'битая ссылка снята')
})

test('служебная отметка не попадает ни в DTO, ни в JSON', async () => {
  const db = fakeDb()
  const store = storeOn(db)
  const task = store.createTask({})
  task.results.push({ n: 1 })
  await store.saveTask(task)
  assert.ok(!Object.keys(task).includes('__persisted'), 'отметка неперечислима')
  assert.ok(!JSON.stringify(task).includes('__persisted'))
  assert.ok(!Object.keys(store.taskToDto(task)).includes('__persisted'))
})
