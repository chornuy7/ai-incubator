import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskSignature, findDuplicateActiveTask } from '../lib/taskDedup.js'

test('taskSignature: нормализует и не зависит от порядка аккаунтов/целей', () => {
  const a = taskSignature({ accountIds: ['a2', 'a1'], goalId: 'g1', channels: ['c2', 'c1'] })
  const b = taskSignature({ accountIds: ['a1', 'a2'], goalId: 'g1', channels: ['c1', 'c2'] })
  assert.equal(a, b) // порядок не важен
  // targets и channels взаимозаменяемы (что задано — то и берём)
  assert.equal(
    taskSignature({ accountIds: ['a1'], goalId: 'g1', targets: ['c1'] }),
    taskSignature({ accountIds: ['a1'], goalId: 'g1', channels: ['c1'] }),
  )
  // разная цель → разная подпись
  assert.notEqual(taskSignature({ accountIds: ['a1'], goalId: 'g1' }), taskSignature({ accountIds: ['a1'], goalId: 'g2' }))
})

test('findDuplicateActiveTask: находит активный дубль, игнорирует завершённые', () => {
  const settings = { accountIds: ['a1', 'a2'], goalId: 'g1', channels: ['@c'] }
  const tasks = [
    { id: 't-done', status: 'done', settings }, // завершённая — не дубль
    { id: 't-run', status: 'running', settings: { accountIds: ['a2', 'a1'], goalId: 'g1', channels: ['@c'] } },
  ]
  const dup = findDuplicateActiveTask(tasks, settings)
  assert.equal(dup?.id, 't-run') // активная с той же подписью

  // нет активных дублей → null
  assert.equal(findDuplicateActiveTask([{ id: 'x', status: 'done', settings }], settings), null)
  // другой набор аккаунтов → не дубль
  assert.equal(findDuplicateActiveTask([{ id: 'y', status: 'running', settings: { accountIds: ['a3'], goalId: 'g1' } }], settings), null)
  // paused тоже считается активным
  assert.equal(findDuplicateActiveTask([{ id: 'p', status: 'paused', settings }], settings)?.id, 'p')
})
