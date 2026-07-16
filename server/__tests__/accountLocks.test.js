import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tryAcquireLocks, releaseTaskLocks, getAccountLock, getAllAccountLocks,
  forceReleaseAccount, assertAccountAvailable, markTaskLive, markTaskDone, isTaskLive,
} from '../lib/accountLocks.js'

test('tryAcquireLocks: захват свободных + конфликт с чужой задачей', () => {
  const acc = ['lk_a1', 'lk_a2']
  assert.equal(tryAcquireLocks(acc, 'mass-react', 'task_1'), null) // свободны → ок
  assert.equal(getAccountLock('lk_a1').taskId, 'task_1')
  // другая задача на те же аккаунты → строка-ошибка
  const err = tryAcquireLocks(['lk_a1'], 'warming', 'task_2')
  assert.ok(typeof err === 'string' && /заняты/i.test(err))
  // та же задача повторно → ок (идемпотентно)
  assert.equal(tryAcquireLocks(['lk_a1'], 'mass-react', 'task_1'), null)
  releaseTaskLocks('task_1')
})

test('tryAcquireLocks: force перехватывает чужой лок', () => {
  tryAcquireLocks(['lk_b1'], 'mass-react', 'task_A')
  assert.equal(getAccountLock('lk_b1').taskId, 'task_A')
  assert.equal(tryAcquireLocks(['lk_b1'], 'warming', 'task_B', { force: true }), null)
  assert.equal(getAccountLock('lk_b1').taskId, 'task_B') // перехвачен
  releaseTaskLocks('task_B')
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

test('assertAccountAvailable: свой/чужой/свободный', () => {
  tryAcquireLocks(['lk_d1'], 'mailing', 'task_D')
  assert.doesNotThrow(() => assertAccountAvailable('lk_free', 'task_X')) // нет лока
  assert.doesNotThrow(() => assertAccountAvailable('lk_d1', 'task_D')) // свой лок
  assert.throws(() => assertAccountAvailable('lk_d1', 'task_OTHER'), /ACCOUNT_BUSY/)
  releaseTaskLocks('task_D')
})

test('живой реестр задач: markTaskLive/Done/isTaskLive', () => {
  assert.equal(isTaskLive('task_L'), false)
  markTaskLive('task_L')
  assert.equal(isTaskLive('task_L'), true)
  markTaskDone('task_L')
  assert.equal(isTaskLive('task_L'), false)
})
