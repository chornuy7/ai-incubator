/**
 * Новые разрезы админ-панели: подписка в отчёте по людям, отчёт ПО КЛИЕНТУ
 * (клиентов может быть больше одного) и «покупки». Проверяем сходимость и границы,
 * а не «функция что-то вернула»: отчёт по клиенту не может быть больше отчёта по
 * всему проекту, а суммы покупок обязаны сходиться со строками.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { usersReport, clientReport, purchasesReport, myStats } from '../adminStats.js'

const isReal = (row) => row.userId && !row.email.startsWith('без владельца') && !row.email.startsWith('удалённый')

test('usersReport: у реальных пользователей есть подписка, у синтетических — null', async () => {
  const r = await usersReport({ since: 0 })
  for (const row of r.rows) {
    if (isReal(row)) {
      assert.ok(row.subscription && typeof row.subscription.all === 'boolean', `${row.email}: подписка — объект`)
      assert.ok(Array.isArray(row.subscription.titles), 'titles — массив')
    } else {
      assert.equal(row.subscription, null, 'строка без владельца — без подписки')
    }
  }
})

test('clientReport по клиенту не больше отчёта по всему проекту', async () => {
  const all = await clientReport({ since: 0 })
  const u = (await usersReport({ since: 0 })).rows.find((x) => isReal(x) && x.tasks > 0)
  if (!u) return // нет данных с владельцем — нечего проверять
  const one = await clientReport({ since: 0, userId: u.userId })
  assert.ok(one.totals.tasks <= all.totals.tasks, 'задачи клиента ≤ проекта')
  assert.ok(one.totals.actions <= all.totals.actions, 'действия клиента ≤ проекта')
  assert.equal(one.totals.tasks, u.tasks, 'задачи в отчёте по клиенту совпали с его строкой в usersReport')
})

test('clientReport по несуществующему клиенту — пусто', async () => {
  const r = await clientReport({ since: 0, userId: 'usr_нет_такого' })
  assert.equal(r.totals.tasks, 0)
  assert.equal(r.rows.length, 0)
})

test('purchasesReport: суммы сходятся со строками, планы отдельным потоком', async () => {
  const p = await purchasesReport({ since: 0 })
  assert.ok(Array.isArray(p.rows) && Array.isArray(p.feed), 'массивы строк и ленты')
  assert.ok(p.plans && Array.isArray(p.plans.feed), 'plans.feed — массив')
  const sum = p.rows.reduce((n, r) => n + r.coins, 0)
  assert.equal(Math.round(sum * 1000), Math.round(p.boughtTotal * 1000), 'сумма по кошелькам = boughtTotal')
})

test('myStats: личный срез не больше проекта и без чужих данных', async () => {
  const u = (await usersReport({ since: 0 })).rows.find((x) => isReal(x) && x.tasks > 0)
  if (!u) return
  const my = await myStats(u.userId, { since: 0 })
  assert.equal(my.totals.tasks, u.tasks, 'мои задачи совпали со строкой в usersReport')
  assert.ok(my.coins >= 0, 'баланс неотрицательный')
  // Активность разложена по родам действий — сумма не больше всех действий.
  const act = my.activity.comments + my.activity.reactions + my.activity.messages + my.activity.views + my.activity.pm
  assert.ok(act <= my.totals.actions, 'активность по родам ≤ всех действий')
})
