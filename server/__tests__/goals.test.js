import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeGoal, isGoalExpired } from '../goals.js'

test('normalizeGoal: цель — это счётчик с жизненным циклом, лишних полей нет', () => {
  const g = normalizeGoal({ name: '  Продажа  ' })
  assert.equal(g.name, 'Продажа') // trim
  assert.equal(g.description, '')
  // Дефолты жизненного цикла: активна, средний приоритет, учёт за всё время.
  assert.equal(g.status, 'active')
  assert.equal(g.priority, 'mid')
  assert.deepEqual(g.period, { mode: 'all', from: null })
  assert.deepEqual(Object.keys(g).sort(), ['description', 'metric', 'name', 'period', 'priority', 'status'])
})

test('статус/приоритет/период: мусор → дефолты, период с датой валидируется', () => {
  const bad = normalizeGoal({ name: 'x', status: 'мусор', priority: 'выдумка', period: { mode: 'from', from: '123123-01-01' } })
  assert.equal(bad.status, 'active')
  assert.equal(bad.priority, 'mid')
  // Битая дата → режим падает на 'all' (учёт за всё время).
  assert.deepEqual(bad.period, { mode: 'all', from: null })
  const ok = normalizeGoal({ name: 'x', status: 'achieved', priority: 'high', period: { mode: 'from', from: '2026-07-01' } })
  assert.equal(ok.status, 'achieved')
  assert.equal(ok.priority, 'high')
  assert.deepEqual(ok.period, { mode: 'from', from: '2026-07-01' })
})

test('цель не тащит за собой чужие поля', () => {
  // Решения 22.07 и 24.07: тон/запреты/аудитория/критерий → агент,
  // дедлайн/дожим/каналы/модули → кампания. Если поле снова просочится в цель,
  // модель поедет обратно, а разъедется это молча — отсюда явная проверка.
  const g = normalizeGoal({
    name: 'x', toneOfVoice: 'на ты', restrictions: 'нельзя', audience: 'IT',
    completionCriteria: 'оплатил', deadline: '2026-08-01', followUp: { enabled: true },
    stages: ['a'], channels: ['@c'], moduleKey: 'mailing', targetAction: 'оплата',
  })
  for (const k of ['toneOfVoice', 'restrictions', 'audience', 'completionCriteria',
    'deadline', 'followUp', 'stages', 'channels', 'moduleKey', 'targetAction']) {
    assert.equal(g[k], undefined, `${k} не место в цели`)
  }
})

test('измеримый результат: число + единица, старое поле leadTarget подхватывается', () => {
  const g = normalizeGoal({ name: 'x', metric: { kind: 'clicks', target: '200' } })
  assert.equal(g.metric.kind, 'clicks')
  assert.equal(g.metric.target, 200)
  assert.equal(g.metric.unit, 'переходов по ссылке', 'единица по виду, если не задали')

  // Цели, заведённые до правки, держали число в leadTarget — оно не должно потеряться.
  assert.equal(normalizeGoal({ name: 'x', leadTarget: 80 }).metric.target, 80)
  assert.equal(normalizeGoal({ name: 'x' }).metric.target, 0, 'не задан → 0')
  assert.equal(normalizeGoal({ name: 'x', metric: { target: -3 } }).metric.target, 0)
  assert.equal(normalizeGoal({ name: 'x', metric: { kind: 'выдумка' } }).metric.kind, 'leads')
  assert.equal(normalizeGoal({ name: 'x', metric: { unit: ' шт ' } }).metric.unit, 'шт')
})

test('потолок измеримого результата: миллион — это план, больше — опечатка', async () => {
  const G = await import('../goals.js?lt=' + Date.now())
  // Без потолка проходило 999999999999 и прогресс-бар терял смысл.
  assert.equal(G.normalizeGoal({ name: 'x', metric: { target: 999999999999 } }).metric.target, G.LEAD_TARGET_MAX)
  assert.equal(G.normalizeGoal({ name: 'x', metric: { target: '012321312' } }).metric.target, G.LEAD_TARGET_MAX)
  assert.equal(G.normalizeGoal({ name: 'x', metric: { target: 50 } }).metric.target, 50)
})

test('§4 isGoalExpired: дедлайн истекает в конце дня', () => {
  // Дедлайн переехал в кампанию, но функция общая — ей всё равно, чей объект пришёл.
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

  const created = await g.createGoal({ name: 'Купить курс', metric: { kind: 'leads', target: 80 } })
  assert.ok(created.id.startsWith('goal_'))
  assert.equal(created.name, 'Купить курс')
  assert.equal(created.metric.target, 80)

  const list = await g.listGoals()
  assert.equal(list.length, 1)

  const upd = await g.updateGoal(created.id, { name: 'Купить курс PRO', metric: { kind: 'clicks', target: 200 } })
  assert.equal(upd.name, 'Купить курс PRO')
  assert.equal(upd.metric.target, 200)
  assert.equal(upd.metric.kind, 'clicks')
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

// ── Счётчик цели: считает сервер, отдаёт кампании для статистики ──
test('счётчик цели: в зачёт идут только выполнившие, дожатые — отдельно', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goalprog-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const g = await import('../goals.js?prog=' + Date.now())
  const L = await import('../leads.js?prog=' + Date.now())

  const goal = await g.createGoal({ name: 'Лиды', metric: { kind: 'leads', target: 4 } })

  // Просто «есть лид» целью не считается: иначе счётчик показывал бы успех там,
  // где человек ещё ничего не сделал.
  await L.upsertLead({ goalId: goal.id, peer: '@a', status: 'cold' })
  await L.upsertLead({ goalId: goal.id, peer: '@b', status: 'hot' })
  let p = await g.goalProgress(goal.id)
  assert.equal(p.done, 0, 'холодный и горячий — ещё не результат')
  assert.equal(p.target, 4)
  assert.equal(p.counted, true)

  // Выполнил целевое действие — вот это в зачёт.
  const { lead: done1 } = await L.upsertLead({ goalId: goal.id, peer: '@c', status: 'target' })
  await L.upsertLead({ goalId: goal.id, peer: '@d', status: 'target' })
  p = await g.goalProgress(goal.id)
  assert.equal(p.done, 2)
  assert.equal(p.pct, 50, '2 из 4')

  // Дожатых считаем отдельной цифрой: они прошли другой путь.
  assert.equal(p.followUpsDone, 0)
  await L.updateLead(done1.id, { followUps: 2 })
  p = await g.goalProgress(goal.id)
  assert.equal(p.followUpsDone, 1, 'один человек, а не два сообщения')
  assert.equal(p.done, 2, 'дожим не раздувает основной счёт')

  // Чужие лиды в счёт цели не идут.
  await L.upsertLead({ goalId: 'goal_другая', peer: '@x', status: 'target' })
  assert.equal((await g.goalProgress(goal.id)).done, 2)

  delete process.env.GOALS_FILE
  delete process.env.LEADS_FILE
})

test('счётчик: без плана процент не выдумывается', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goalprog2-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  process.env.LEADS_FILE = path.join(dir, 'leads.json')
  const g = await import('../goals.js?prog2=' + Date.now())
  const goal = await g.createGoal({ name: 'Без плана' })
  const p = await g.goalProgress(goal.id)
  assert.equal(p.target, 0)
  assert.equal(p.pct, 0, 'делить на ноль нечего — и рисовать прогресс тоже')
  delete process.env.GOALS_FILE
  delete process.env.LEADS_FILE
})

test('счётчик: вид без адаптера честно говорит, что считать нечем', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goalprog3-'))
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  const g = await import('../goals.js?prog3=' + Date.now())
  // «Вступления» посчитать пока нечем — лучше пустой счётчик, чем нарисованный ноль,
  // который оператор прочитает как «ничего не работает».
  const goal = await g.createGoal({ name: 'Вступления', metric: { kind: 'joins', target: 100 } })
  const p = await g.goalProgress(goal.id)
  assert.equal(p.counted, false)
  assert.equal(p.target, 100, 'план показываем всегда')
  delete process.env.GOALS_FILE
})
