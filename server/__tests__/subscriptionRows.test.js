/**
 * Состав подписки хранится строками в `user_subscriptions` (созвон 19.08: «никакого
 * джейсона в базе данных»). Разбор строк проверяем отдельно: здесь три правила из
 * контракта переноса, и каждое из них уже терялось при слияниях веток.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rowsToModules } from '../balance.js'

const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

test('состав собирается из строк, дата — одна на подписку', () => {
  const due = Date.now() + 20 * DAY
  const r = rowsToModules([
    { module_key: 'mailing', expires_at: iso(due) },
    { module_key: 'warming', expires_at: iso(due) },
  ])
  assert.deepEqual(r.modules, ['mailing', 'warming'])
  assert.equal(r.expiresAt, new Date(iso(due)).getTime())
})

test('метка «*» = все модули: разворачивать в перечень нельзя', () => {
  // 'all' — это «все, ВКЛЮЧАЯ будущие»: список конкретных ключей перестал бы выдавать
  // новый модуль автоматически. Поэтому провижининг не раскладывается по строкам.
  //
  // Строка-метка — УСТАРЕВШИЙ способ записи (MR-290), читается ради окна выката: миграции
  // применяются раньше кода, и в промежутке метку ещё пишет предыдущая версия.
  const r = rowsToModules([{ module_key: '*', expires_at: null }])
  assert.equal(r.modules, 'all')
  assert.equal(r.expiresAt, null)
})

test('«все модули» — признак подписки, а не строка в списке модулей', () => {
  // MR-290: строка user_subscriptions означает «есть модуль X». Строка со звёздочкой
  // означала свойство всей подписки, записанное в поле для имени модуля, — из-за неё на
  // module_key нельзя было поставить внешний ключ на справочник. Признак переехал в
  // subscriptions.all_modules, и строк состава у такой подписки нет вовсе.
  const r = rowsToModules([], true)
  assert.equal(r.modules, 'all', 'без строк, но с признаком — это «всё включено», а не пустая подписка')

  // Признак сильнее перечня: докупив модуль поверх «всё включено», человек не должен
  // потерять остальные — иначе провижининг молча сузился бы до одной строки.
  const due = Date.now() + 10 * DAY
  const mixed = rowsToModules([{ module_key: 'mailing', expires_at: iso(due) }], true)
  assert.equal(mixed.modules, 'all')
  assert.equal(mixed.expiresAt, new Date(iso(due)).getTime(), 'срок по-прежнему берётся со строк')
})

test('истёкшая подписка отдаёт ПОЛНЫЙ состав — иначе продлевать нечего', () => {
  // Контракт: чтение, отдающее только действующие строки, превращает просрочку в
  // «ничего не куплено» — человек слышит «модуль не входит в подписку» вместо
  // «истекла, продлите», и кнопке продления нечего продлевать.
  const past = Date.now() - 5 * DAY
  const r = rowsToModules([
    { module_key: 'mailing', expires_at: iso(past) },
    { module_key: 'parsing', expires_at: iso(past) },
  ])
  assert.deepEqual(r.modules, ['mailing', 'parsing'], 'состав виден и после окончания')
  assert.ok(r.expiresAt < Date.now(), 'но срок — в прошлом: это просрочка, а не активная подписка')
})

test('разъехавшиеся даты — берём максимум, подписка одна', () => {
  const a = Date.now() + 5 * DAY
  const b = Date.now() + 25 * DAY
  const r = rowsToModules([
    { module_key: 'mailing', expires_at: iso(a) },
    { module_key: 'warming', expires_at: iso(b) },
  ])
  assert.equal(r.expiresAt, new Date(iso(b)).getTime(), 'дата подписки — самая поздняя из строк')
})

test('пустой список строк — пустой состав, без падения', () => {
  assert.deepEqual(rowsToModules([]).modules, [])
  assert.equal(rowsToModules([]).expiresAt, null)
})
