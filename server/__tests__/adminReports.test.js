/**
 * Разрезы админ-панели: по людям, по аккаунтам, по дням, проблемы, CRM.
 *
 * Проверяем не «функция что-то вернула», а СХОДИМОСТЬ: одна и та же величина,
 * посчитанная разными разрезами, обязана совпадать. Расхождение между вкладками
 * («в панели 82 задачи, а по людям 80») читается как ошибка счёта и подрывает
 * доверие ко всей статистике, включая счёт клиенту.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  usersReport, accountReport, activeNow, dailySpend, problems, crmOverview, clientReport,
} from '../adminStats.js'

test('usersReport: строки сходятся с итогами', async () => {
  const r = await usersReport({ since: 0 })
  const sum = (k) => r.rows.reduce((n, x) => n + x[k], 0)
  assert.equal(r.totals.tasks, sum('tasks'), 'задачи')
  assert.equal(r.totals.actions, sum('actions'), 'действия')
  assert.equal(r.totals.tokens, sum('tokens'), 'токены')
  assert.equal(Math.round(r.totals.spent * 1000), Math.round(sum('spent') * 1000), 'списано')
})

test('usersReport: разрез «куда» не больше общего итога человека', async () => {
  const r = await usersReport({ since: 0 })
  for (const row of r.rows) {
    const byMod = row.where.reduce((n, w) => n + w.actions, 0)
    assert.ok(byMod <= row.actions + 1, `${row.email}: сумма по модулям (${byMod}) не превышает общую (${row.actions})`)
  }
})

test('usersReport и clientReport считают одни и те же деньги за действия', async () => {
  const [u, c] = await Promise.all([usersReport({ since: 0 }), clientReport({ since: 0 })])
  // Обе стороны берут task.spentCoins, просто режут по-разному: по людям и по модулям.
  assert.equal(
    Math.round(u.totals.spent * 100),
    Math.round(c.totals.actionCoins * 100),
    'разрез по людям и разрез по модулям дают одну сумму',
  )
})

test('usersReport: задачи без владельца не теряются, а показаны отдельной строкой', async () => {
  const r = await usersReport({ since: 0 })
  const orphan = r.rows.find((x) => x.email.startsWith('без владельца'))
  // Строка появляется только если такие задачи есть — но если есть, она обязана быть.
  if (r.totals.tasks) {
    const named = r.rows.filter((x) => !x.email.startsWith('без владельца')).reduce((n, x) => n + x.tasks, 0)
    if (named < r.totals.tasks) assert.ok(orphan, 'ничьи задачи должны быть видны, а не молча пропасть')
  }
})

test('accountReport: делит действия между аккаунтами, а не приписывает каждому все', async () => {
  const rep = await accountReport('acc_несуществующий')
  assert.equal(rep.tasks, 0, 'у неизвестного аккаунта нет задач')
  assert.equal(rep.actions, 0)
  assert.deepEqual(rep.byModule, [])
  assert.equal(rep.leads.total, 0)
})

test('accountReport: пустой id — null, а не пустая карточка', async () => {
  assert.equal(await accountReport(''), null)
  assert.equal(await accountReport(null), null)
})

test('accountReport: итог денег = за действия + за ИИ', async () => {
  const rep = await accountReport('acc_99a46d69fa1e')
  if (!rep) return
  assert.equal(
    Math.round(rep.totalCoins * 1000),
    Math.round((rep.spent + rep.tokenCoins) * 1000),
    'сумма не разъезжается со слагаемыми',
  )
  const byMod = rep.byModule.reduce((n, m) => n + m.actions, 0)
  assert.ok(byMod <= rep.actions + rep.byModule.length, 'разрез по модулям не превышает общего (с учётом округления долей)')
})

test('activeNow: running и paused не пересекаются', async () => {
  const a = await activeNow()
  const ids = new Set(a.running.map((t) => t.id))
  for (const t of a.paused) assert.ok(!ids.has(t.id), `${t.id} не может быть одновременно идущей и на паузе`)
  for (const t of [...a.running, ...a.paused]) {
    assert.ok(t.percent >= 0 && t.percent <= 100, `${t.id}: процент в границах`)
  }
})

test('dailySpend: заполняет ВСЕ дни диапазона, включая пустые', async () => {
  const d = await dailySpend({ days: 7 })
  assert.equal(d.rows.length, 7, 'провал в работе — тоже сигнал, дни не схлопываются')
  const days = d.rows.map((r) => r.day)
  assert.deepEqual(days, [...days].sort(), 'по возрастанию даты')
  for (const r of d.rows) {
    assert.equal(
      Math.round(r.coins * 1000),
      Math.round((r.tokenCoins + r.actionCoins) * 1000),
      `${r.day}: итог = ИИ + действия`,
    )
  }
})

test('dailySpend: диапазон ограничен разумными рамками', async () => {
  assert.equal((await dailySpend({ days: 0 })).days, 30, 'ноль = «не указано», значит месяц по умолчанию')
  assert.equal((await dailySpend({ days: 999 })).days, 90, 'не даём просить историю за годы')
  assert.equal((await dailySpend({})).days, 30, 'по умолчанию месяц')
})

test('problems: числа сходятся со списками', async () => {
  const p = await problems({ since: 0 })
  assert.ok(p.failedTotal >= p.failedTasks.length, 'список — верхушка, итог — полный')
  assert.ok(p.failedTasks.length <= 20, 'список ограничен, чтобы не тащить всё')
  for (const t of p.failedTasks) assert.ok(t.errors > 0, `${t.id} попал в список не просто так`)
  // Отсортировано по тяжести: чинить начинают с худшего.
  const errs = p.failedTasks.map((t) => t.errors)
  assert.deepEqual(errs, [...errs].sort((a, b) => b - a), 'по убыванию числа ошибок')
})

test('crmOverview: воронка сходится с общим числом лидов', async () => {
  const c = await crmOverview({})
  const sum = Object.values(c.byStatus).reduce((n, v) => n + v, 0)
  assert.equal(sum, c.total, 'каждый лид попал ровно в один статус')
  assert.ok(c.conversion >= 0 && c.conversion <= 100, 'конверсия — процент')
  assert.ok(c.stuck <= c.total, 'зависших не больше, чем всего')
  const owners = c.owners.reduce((n, o) => n + o.count, 0)
  assert.ok(owners <= c.total, 'лиды без исполнителя просто не попадают в разрез')
})

test('crmOverview: порог «зависших» настраивается', async () => {
  const a = await crmOverview({ stuckDays: 1 })
  const b = await crmOverview({ stuckDays: 90 })
  assert.equal(a.stuckDays, 1)
  assert.equal(b.stuckDays, 90)
  assert.ok(a.stuck >= b.stuck, 'чем короче порог, тем больше попадает в зависшие')
})
