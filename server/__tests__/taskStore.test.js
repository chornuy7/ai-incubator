import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskStore } from '../lib/taskStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const moduleKey = 'test-ts-' + Date.now()
const moduleDir = path.join(__dirname, '..', 'data', 'modules', moduleKey)

test('saveTask: обычное сохранение НЕ затирает выставленные извне stop/pause (гонка §3.9)', async () => {
  const store = createTaskStore(moduleKey, 'tt')
  try {
    const task = { id: 'tt_1', status: 'running', stopRequested: false, pauseRequested: false }
    await store.saveTask(task)
    assert.equal((await store.loadTask('tt_1')).stopRequested, false)

    // Внешняя команда «стоп» (control:true имеет право менять флаги).
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: true }, { control: true })
    assert.equal((await store.loadTask('tt_1')).stopRequested, true)

    // Воркер сохраняет прогресс с stopRequested:false — флаг с диска должен СОХРАНИТЬСЯ.
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: false, progress: { done: 5 } })
    const afterWorkerSave = await store.loadTask('tt_1')
    assert.equal(afterWorkerSave.stopRequested, true, 'stopRequested не должен затираться обычным save')
    assert.equal(afterWorkerSave.progress.done, 5)

    // Возобновление (control:true) со stopRequested:false — флаг сбрасывается.
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: false }, { control: true })
    assert.equal((await store.loadTask('tt_1')).stopRequested, false)
  } finally {
    await fs.rm(moduleDir, { recursive: true, force: true })
  }
})

test('loadTask: несуществующая задача → null', async () => {
  const store = createTaskStore(moduleKey + '-x', 'tt')
  const r = await store.loadTask('nope')
  assert.equal(r, null)
  await fs.rm(path.join(__dirname, '..', 'data', 'modules', moduleKey + '-x'), { recursive: true, force: true })
})

test('прогресс: без заданного лимита знаменатель не подменяется случайным числом', async () => {
  // Живой прогон 17.08: AI Rating проверил 6 аккаунтов из 6, а дашборд показал «6/35».
  // У модуля нет лимита действий — объём задачи это число аккаунтов, — но общий
  // resolveTotalTarget подставлял свой дефолт (100) и сеял из него случайную цель.
  const store = createTaskStore('ggr_progress_test', 'gpt')
  const task = store.createTask({ accountIds: ['a', 'b', 'c'] }, {})
  task.progress = { done: 3, total: 3, actionsDone: 3 }
  await store.saveTask(task)

  const loaded = await store.loadTask(task.id)
  assert.equal(loaded.progress.total, 3, 'знаменатель остаётся числом аккаунтов')

  // А там, где лимит задан, уточнение по-прежнему работает — «9 из 10» больше не «Готово».
  const limited = store.createTask({ accountIds: ['a'], maxComments: 10, minComments: 10 }, {})
  limited.progress = { done: 0, total: 999, actionsDone: 0 }
  await store.saveTask(limited)
  const back = await store.loadTask(limited.id)
  assert.equal(back.progress.total, 10, 'заданный лимит по-прежнему уточняет знаменатель')
})

test('фатальная ошибка переживает перезагрузку задачи и даёт статус «ошибка»', async () => {
  // Живой прогон 18.08: ключ OpenAI отклонён, в лог легло «Задача остановлена —
  // комментарии без ИИ не публикуем», после чего работа ПРОДОЛЖИЛАСЬ, а итог
  // показался как «Готово · 0/2». Причина: воркер в конце круга перечитывает задачу
  // с диска, и невсохранённый stopRequested терялся.
  const { statusAfterRun, failTask, finishNote } = await import('../modules/workers.js')

  const store = createTaskStore('fatal_test', 'ft')
  const task = store.createTask({ accountIds: ['a'] }, {})
  await store.saveTask(task)

  await failTask(task, store, 'ИИ недоступен: ключ отклонён (401)')

  // 1. Флаг лежит на диске — перечитывание его не теряет.
  const reloaded = await store.loadTask(task.id)
  assert.equal(reloaded.stopRequested, true, 'цикл обязан остановиться после перезагрузки')
  assert.match(reloaded.fatalError, /ключ отклонён/)

  // 2. Статус — ошибка, а не «готово» и не «остановлено».
  assert.equal(statusAfterRun(reloaded), 'error')

  // 3. Побочная запись лога не стирает пометку об ошибке.
  await store.appendLog(reloaded, 'info', 'что-то ещё')
  const after = await store.loadTask(task.id)
  assert.equal(statusAfterRun(after), 'error', 'запись лога не должна «чинить» упавшую задачу')

  // 4. Итоговая строка называет причину, а не рапортует «Завершено».
  after.status = 'error'
  assert.match(finishNote(after), /с ошибкой/)
})

test('statusAfterRun: обычные исходы не задеты', async () => {
  const { statusAfterRun } = await import('../modules/workers.js')
  assert.equal(statusAfterRun({}), 'done')
  assert.equal(statusAfterRun({ stopRequested: true }), 'stopped')
  assert.equal(statusAfterRun({ pauseRequested: true }), 'paused')
  // Пауза и стоп вместе с фатальной ошибкой — всё равно ошибка: она старше.
  assert.equal(statusAfterRun({ pauseRequested: true, fatalError: 'x' }), 'error')
})
