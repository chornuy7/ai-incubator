import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeGoal, isGoalExpired } from '../goals.js'

test('normalizeGoal: дефолты и типы', () => {
  const g = normalizeGoal({ name: '  Продажа  ', stages: ['знакомство', 1] })
  assert.equal(g.name, 'Продажа') // trim
  assert.deepEqual(g.stages, ['знакомство', '1']) // всё в строки
  assert.equal(g.description, '')
  assert.equal(g.targetAction, '')
  assert.equal(g.completionCriteria, '')
  assert.equal(g.audience, '')
  // §4: дедлайн и цель по лидам
  assert.equal(g.deadline, null) // не задан → null
  assert.equal(g.leadTarget, 0) // не задан → 0
  assert.equal(normalizeGoal({ name: 'x', deadline: '2026-08-01' }).deadline, '2026-08-01')
  assert.equal(normalizeGoal({ name: 'x', deadline: 'не дата' }).deadline, null) // невалидная → null
  assert.equal(normalizeGoal({ name: 'x', leadTarget: '50' }).leadTarget, 50)
  assert.equal(normalizeGoal({ name: 'x', leadTarget: -3 }).leadTarget, 0)
})

test('§4 isGoalExpired: дедлайн истекает в конце дня', () => {
  assert.equal(isGoalExpired({ deadline: null }), false) // нет дедлайна
  assert.equal(isGoalExpired({}), false)
  const day = '2026-07-15'
  const base = new Date(day).getTime()
  assert.equal(isGoalExpired({ deadline: day }, base), false) // начало дня — не истёк
  assert.equal(isGoalExpired({ deadline: day }, base + 23 * 3600 * 1000), false) // в течение дня — не истёк
  assert.equal(isGoalExpired({ deadline: day }, base + 25 * 3600 * 1000), true) // следующий день — истёк
  assert.equal(isGoalExpired({ deadline: 'мусор' }, base + 1e12), false) // невалидная дата
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

test('§4 дедлайн: отсекаем опечатки в годе и несуществующие даты', async () => {
  const G = await import('../goals.js?dl=' + Date.now())
  // Найдено ручным тестом 21.07: в поле даты проходил год 123123 — на карточке
  // рисовалось «до 24.07.123123», и цель не истекала никогда.
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '123123-07-24' }).deadline, null)
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '0001-01-01' }).deadline, null)
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '1899-01-01' }).deadline, null)
  assert.equal(G.normalizeGoal({ name: 'x', deadline: 'abc' }).deadline, null)
  // Несуществующая дата: Date «доворачивает» 31 февраля на март — такое не принимаем.
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '2026-02-31' }).deadline, null)
  // Нормальные даты проходят; прошлое разрешено — по нему проверяют «просрочено».
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '2026-07-24' }).deadline, '2026-07-24')
  assert.equal(G.normalizeGoal({ name: 'x', deadline: '2020-01-01' }).deadline, '2020-01-01')
})

test('§4 цель по лидам: ограничена сверху', async () => {
  const G = await import('../goals.js?lt=' + Date.now())
  // Без потолка проходило 999999999999 и прогресс-бар терял смысл.
  assert.equal(G.normalizeGoal({ name: 'x', leadTarget: 999999999999 }).leadTarget, G.LEAD_TARGET_MAX)
  assert.equal(G.normalizeGoal({ name: 'x', leadTarget: '012321312' }).leadTarget, G.LEAD_TARGET_MAX)
  assert.equal(G.normalizeGoal({ name: 'x', leadTarget: 50 }).leadTarget, 50)
  assert.equal(G.normalizeGoal({ name: 'x', leadTarget: -5 }).leadTarget, 0)
})

test('§4 createGoal объясняет плохой дедлайн, а не молча теряет дату', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goals-dl-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  const G = await import('../goals.js?cg=' + Date.now())
  await assert.rejects(() => G.createGoal({ name: 'Тест', deadline: '123123-07-24' }), /дедлайн/i)
  const ok = await G.createGoal({ name: 'Тест', deadline: '2026-12-31' })
  assert.equal(ok.deadline, '2026-12-31')
  delete process.env.GOALS_FILE
})
