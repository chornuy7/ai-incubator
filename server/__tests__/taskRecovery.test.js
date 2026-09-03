import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskStore } from '../lib/taskStore.js'
import { MAX_BOOT_RESUMES, resumeMarkedTasks } from '../lib/taskRecovery.js'
import { reconcileStaleTasksOnBoot } from '../lib/accountLocks.js'
import { getModuleStore } from '../modules/registry.js'

// Деплой не должен убивать работу пользователей. Раньше любой рестарт API помечал все
// активные задачи `stopped`: на одном пользователе это раздражает, на тысяче — авария
// при каждой выкатке.

test('рестарт переводит активные задачи в паузу с пометкой на восстановление, а не в стоп', async () => {
  const store = getModuleStore('warming')
  const task = store.createTask({ accountIds: ['acc_boot_1'] }, {})
  task.status = 'running'
  await store.saveTask(task, { control: true })

  await reconcileStaleTasksOnBoot()

  const after = await store.loadTask(task.id)
  assert.equal(after.status, 'paused', 'стоп означал бы решение человека — здесь его не было')
  assert.equal(after.resumeOnBoot, true, 'без пометки задачу никто не поднимет')
  assert.equal(after.stopRequested, false, 'флаг стопа не должен блокировать возобновление')
  assert.ok(after.interruptedAt, 'момент прерывания записан')
})

test('задачу, остановленную человеком, рестарт не воскрешает', async () => {
  const store = getModuleStore('warming')
  const stopped = store.createTask({ accountIds: ['acc_boot_2'] }, {})
  stopped.status = 'stopped'
  stopped.stopRequested = true
  await store.saveTask(stopped, { control: true })

  await reconcileStaleTasksOnBoot()

  const after = await store.loadTask(stopped.id)
  assert.equal(after.status, 'stopped')
  assert.ok(!after.resumeOnBoot, 'решение оператора остаётся в силе после перезапуска')
})

test('петля перезапусков обрывается: после лимита задача остаётся остановленной', async () => {
  const store = getModuleStore('warming')
  const looping = store.createTask({ accountIds: ['acc_boot_3'] }, {})
  looping.status = 'paused'
  looping.resumeOnBoot = true
  // Задача уже поднималась предельное число раз — значит, она стабильно роняет процесс.
  looping.bootResumes = MAX_BOOT_RESUMES
  await store.saveTask(looping, { control: true })

  const { resumed, skipped } = await resumeMarkedTasks()

  assert.equal(resumed.includes(looping.id), false, 'вечно поднимать падающую задачу нельзя')
  assert.ok(skipped.some((s) => s.id === looping.id), 'пропуск должен быть виден, а не молчалив')

  const after = await store.loadTask(looping.id)
  assert.equal(after.status, 'stopped')
  assert.equal(after.resumeOnBoot, false, 'пометка снята — следующий старт её не подхватит')
  const warned = (after.logs || []).some((l) => /Автовосстановление отключено/.test(l.message))
  assert.ok(warned, 'причина отключения обязана попасть в лог задачи')
})

test('счётчик подъёмов растёт — иначе лимит никогда не сработает', async () => {
  const store = createTaskStore('recovery_counter_test', 'rct')
  const t = store.createTask({ accountIds: ['a'] }, {})
  t.status = 'paused'
  t.resumeOnBoot = true
  await store.saveTask(t, { control: true })
  assert.equal(Number(t.bootResumes || 0), 0, 'новая задача начинает с нуля')
})

// Главный сценарий заказчика: «тысяча юзеров, выкатываем обнову — у всех всё слетает».
// Деплой не должен тратить лимит автоподъёмов: он для ПЕТЕЛЬ, а не для выкаток.
test('деплои не съедают лимит: задача, которая работает между рестартами, поднимается снова', async () => {
  const store = getModuleStore('warming')
  const t = store.createTask({ accountIds: ['acc_boot_progress'] }, {})
  t.status = 'paused'
  t.resumeOnBoot = true
  // Три подъёма уже израсходованы, но с прошлого раза задача сделала ещё действия.
  t.bootResumes = MAX_BOOT_RESUMES
  t.bootResumeProgress = 7
  t.progress = { done: 12, total: 30 }
  await store.saveTask(t, { control: true })

  const { skipped } = await resumeMarkedTasks()

  // Проверяем РЕШЕНИЕ восстановления, а не судьбу воркера: в тестовой среде аккаунтов
  // нет, поэтому поднятая задача тут же и завершится — это к делу не относится.
  const after = await store.loadTask(t.id)
  assert.ok(!skipped.some((s) => s.id === t.id && s.reason === 'превышен лимит автоподъёмов'),
    'лимит не должен срабатывать на задаче, которая двигалась между рестартами')
  assert.equal(after.bootResumes, 1, 'счётчик начат заново: три прошлых подъёма были деплоями, а не петлёй')
  assert.equal(after.bootResumeProgress, 12, 'запомнили прогресс на момент подъёма — для следующей проверки')
  const warned = (after.logs || []).some((l) => /Автовосстановление отключено/.test(l.message))
  assert.ok(!warned, 'живую задачу не отключаем от автоподъёма')
})

test('петля без прогресса лимит всё-таки тратит', async () => {
  const store = getModuleStore('warming')
  const t = store.createTask({ accountIds: ['acc_boot_loop'] }, {})
  t.status = 'paused'
  t.resumeOnBoot = true
  t.bootResumes = MAX_BOOT_RESUMES
  // Прогресс не сдвинулся с прошлого подъёма — задача падает, не успев ничего сделать.
  t.bootResumeProgress = 7
  t.progress = { done: 7, total: 30 }
  await store.saveTask(t, { control: true })

  const { skipped } = await resumeMarkedTasks()

  const after = await store.loadTask(t.id)
  assert.equal(after.status, 'stopped')
  assert.ok(skipped.some((s) => s.id === t.id && s.reason === 'превышен лимит автоподъёмов'))
})
