import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tryAcquireLocks, releaseTaskLocks, getAccountLock, getAllAccountLocks,
  forceReleaseAccount, assertAccountAvailable, markTaskLive, markTaskDone, isTaskLive,
} from '../lib/accountLocks.js'

test('tryAcquireLocks: многомодульность — конфликт только внутри одного модуля (20.08)', () => {
  const acc = ['lk_a1', 'lk_a2']
  assert.equal(tryAcquireLocks(acc, 'mass-react', 'task_1'), null) // свободны → ок
  assert.equal(getAccountLock('lk_a1').taskId, 'task_1')
  // ДРУГОЙ модуль на те же аккаунты → разрешено: аккаунт работает в нескольких модулях.
  assert.equal(tryAcquireLocks(['lk_a1'], 'warming', 'task_2'), null)
  assert.equal(getAccountLock('lk_a1').holders.length, 2)
  assert.deepEqual(getAccountLock('lk_a1').alsoLabels, ['Прогрев'])
  // ТОТ ЖЕ модуль другой задачей → конфликт: два mass-react дублировали бы работу.
  const err = tryAcquireLocks(['lk_a1'], 'mass-react', 'task_3')
  assert.ok(typeof err === 'string' && /в этом же модуле/i.test(err))
  // та же задача повторно → ок (идемпотентно), держателей не плодит
  assert.equal(tryAcquireLocks(['lk_a1'], 'mass-react', 'task_1'), null)
  assert.equal(getAccountLock('lk_a1').holders.length, 2)
  releaseTaskLocks('task_1')
  // после ухода первой задачи аккаунт остаётся у второй (warming)
  assert.equal(getAccountLock('lk_a1').moduleKey, 'warming')
  releaseTaskLocks('task_2')
  assert.equal(getAccountLock('lk_a1'), null)
})

test('tryAcquireLocks: force перехватывает слот того же модуля, чужие модули не трогает', () => {
  tryAcquireLocks(['lk_b1'], 'mass-react', 'task_A')
  tryAcquireLocks(['lk_b1'], 'warming', 'task_W')
  assert.equal(tryAcquireLocks(['lk_b1'], 'mass-react', 'task_B', { force: true }), null)
  const lock = getAccountLock('lk_b1')
  const reactHolders = lock.holders.filter((h) => h.moduleKey === 'mass-react')
  assert.deepEqual(reactHolders.map((h) => h.taskId), ['task_B']) // перехвачен
  assert.ok(lock.holders.some((h) => h.taskId === 'task_W'), 'прогрев не пострадал')
  releaseTaskLocks('task_B'); releaseTaskLocks('task_W')
  assert.equal(getAccountLock('lk_b1'), null)
})

test('releaseTaskLocks / forceReleaseAccount', () => {
  tryAcquireLocks(['lk_c1', 'lk_c2'], 'neuro-commenting', 'task_C')
  assert.equal(Object.keys(getAllAccountLocks()).filter((k) => k.startsWith('lk_c')).length, 2)
  assert.ok(forceReleaseAccount('lk_c1')) // вернёт снятый лок
  assert.equal(getAccountLock('lk_c1'), null)
  assert.equal(forceReleaseAccount('lk_c1'), null) // уже снят
  releaseTaskLocks('task_C')
  assert.equal(getAccountLock('lk_c2'), null)
})

test('assertAccountAvailable: любой из держателей проходит, посторонняя задача — нет', () => {
  tryAcquireLocks(['lk_d1'], 'mailing', 'task_D')
  tryAcquireLocks(['lk_d1'], 'neuro-commenting', 'task_E')
  assert.doesNotThrow(() => assertAccountAvailable('lk_free', 'task_X')) // нет лока
  assert.doesNotThrow(() => assertAccountAvailable('lk_d1', 'task_D')) // первый держатель
  assert.doesNotThrow(() => assertAccountAvailable('lk_d1', 'task_E')) // второй держатель
  assert.throws(() => assertAccountAvailable('lk_d1', 'task_OTHER'), /ACCOUNT_BUSY/)
  releaseTaskLocks('task_D'); releaseTaskLocks('task_E')
})

test('живой реестр задач: markTaskLive/Done/isTaskLive', () => {
  assert.equal(isTaskLive('task_L'), false)
  markTaskLive('task_L')
  assert.equal(isTaskLive('task_L'), true)
  markTaskDone('task_L')
  assert.equal(isTaskLive('task_L'), false)
})
