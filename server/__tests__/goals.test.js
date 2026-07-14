import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeGoal } from '../goals.js'

test('normalizeGoal: дефолты и типы', () => {
  const g = normalizeGoal({ name: '  Продажа  ', stages: ['знакомство', 1] })
  assert.equal(g.name, 'Продажа') // trim
  assert.deepEqual(g.stages, ['знакомство', '1']) // всё в строки
  assert.equal(g.description, '')
  assert.equal(g.targetAction, '')
  assert.equal(g.completionCriteria, '')
  assert.equal(g.audience, '')
})

test('CRUD целей на изолированном файле', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goals-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  const g = await import('../goals.js?crud=' + Date.now()) // свежий инстанс с env

  assert.deepEqual(await g.listGoals(), [])

  const created = await g.createGoal({ name: 'Купить курс', targetAction: 'оплата', stages: ['a', 'b'] })
  assert.ok(created.id.startsWith('goal_'))
  assert.equal(created.name, 'Купить курс')
  assert.equal(created.targetAction, 'оплата')

  const list = await g.listGoals()
  assert.equal(list.length, 1)

  const upd = await g.updateGoal(created.id, { name: 'Купить курс PRO', audience: 'IT' })
  assert.equal(upd.name, 'Купить курс PRO')
  assert.equal(upd.audience, 'IT')
  assert.ok(upd.updatedAt >= created.updatedAt)

  assert.equal(await g.updateGoal('нет', {}), null)
  assert.equal(await g.deleteGoal('нет'), false)
  assert.equal(await g.deleteGoal(created.id), true)
  assert.deepEqual(await g.listGoals(), [])

  delete process.env.GOALS_FILE
})

test('createGoal без имени — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goals-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  const g = await import('../goals.js?noname=' + Date.now())
  await assert.rejects(() => g.createGoal({ description: 'без имени' }), /название/i)
  delete process.env.GOALS_FILE
})
