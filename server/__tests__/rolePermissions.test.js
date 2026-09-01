/**
 * MR-290: права роли строками вместо дерева json.
 *
 * Это единственное место задачи, где ошибка означает не потерянные данные, а открытый
 * чужому человеку кабинет. Поэтому проверяется не «переводится ли», а сохраняется ли
 * СМЫСЛ: право, которого не было, не должно появиться, а снятое — не должно вернуться.
 *
 * Образец взят из боевых данных (роль с доступом к рассылке и точечными запретами на
 * аккаунты), а не выдуман: выдуманный образец проверяет выдуманную структуру.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rulesToPermissions, permissionsToRules } from '../roles.js'

const БОЕВОЙ_ОБРАЗЕЦ = {
  modules: { mailing: 'allow', 'neuro-commenting': 'deny' },
  blocks: { 'mailing:results': 'deny', 'mailing:run': 'allow' },
  sections: { billing: 'allow' },
  resources: {
    timers: 'deny',
    allTasks: 'deny',
    accounts: { acc_99a46d69fa1e: 'deny', acc_9c93eedbb6f2: 'deny', acc_fake: 'allow' },
    folders: {},
  },
}

/** Строки, как их вернёт база: без role_id и в произвольном порядке. */
const asRows = (rules) => rules.map(({ scope, subject, item_id, effect }) => ({ scope, subject, item_id, effect }))

test('дерево прав переживает перевод в строки и обратно без изменений', () => {
  const обратно = rulesToPermissions(asRows(permissionsToRules('role_x', БОЕВОЙ_ОБРАЗЕЦ)))
  // `folders: {}` круг не переживает, и это правильно: пустой объект — не право, а
  // отсутствие правил. Читатели прав и так пишут `?.resources?.folders || {}`, так что
  // «пусто» и «нет ключа» для них одно и то же. Всё остальное обязано совпасть.
  const ожидаемо = { ...БОЕВОЙ_ОБРАЗЕЦ, resources: { ...БОЕВОЙ_ОБРАЗЕЦ.resources } }
  delete ожидаемо.resources.folders
  assert.deepEqual(обратно, ожидаемо, 'права изменились при переводе')
})

test('пустой набор правил — это «прав нет», а не «читать не удалось»', () => {
  // Разница видна только на этом уровне: подмена пустого набора старым деревом вернула
  // бы снятые права, и заметить это можно было бы только по чужому доступу.
  assert.deepEqual(rulesToPermissions([]), { modules: {}, blocks: {}, sections: {}, resources: {} })
})

test('порядок строк из базы на результат не влияет', () => {
  const rules = asRows(permissionsToRules('role_x', БОЕВОЙ_ОБРАЗЕЦ))
  const прямо = rulesToPermissions(rules)
  const наоборот = rulesToPermissions([...rules].reverse())
  assert.deepEqual(наоборот, прямо, 'база не обязана возвращать строки в каком-то порядке')
})

test('правило на конкретный аккаунт перекрывает правило на «аккаунты вообще»', () => {
  // Точнее — значит сильнее. Обратный порядок означал бы, что общий запрет стирает
  // выданное поимённо разрешение (или наоборот) в зависимости от ответа базы.
  const p = rulesToPermissions([
    { scope: 'resource', subject: 'accounts', item_id: 'acc_1', effect: 'allow' },
    { scope: 'resource', subject: 'accounts', item_id: '', effect: 'deny' },
  ])
  assert.deepEqual(p.resources.accounts, { acc_1: 'allow' })
})

test('значение не allow и не deny в права не попадает', () => {
  // Опечатка `alow` в json записывалась молча и читалась как «не allow», то есть как
  // запрет: право пропадало без ошибки. В строках такого значения просто не будет.
  const rules = permissionsToRules('role_x', { modules: { mailing: 'alow', warming: 'allow' } })
  assert.deepEqual(rules.map((r) => r.subject), ['warming'])
})

test('чужие разрезы прав в строки не уезжают', () => {
  // freeAccess и personalFor лежат в колонках роли; попав сюда, они стали бы правилами
  // с бессмысленным разрезом и заняли бы место в матрице доступа.
  const rules = permissionsToRules('role_x', { freeAccess: true, personalFor: 'usr_1', modules: { mailing: 'allow' } })
  assert.deepEqual(rules, [{ role_id: 'role_x', scope: 'module', subject: 'mailing', item_id: '', effect: 'allow' }])
})

test('пустой ключ правилом не становится', () => {
  // Пустой subject прошёл бы в базу и упёрся бы в ограничение, уронив сохранение роли
  // целиком — вместе с остальными правами.
  const rules = permissionsToRules('role_x', {
    modules: { '': 'allow' },
    resources: { accounts: { '': 'deny', acc_1: 'allow' } },
  })
  assert.deepEqual(rules, [{ role_id: 'role_x', scope: 'resource', subject: 'accounts', item_id: 'acc_1', effect: 'allow' }])
})

test('неизвестный разрез из базы игнорируется, а не ломает права', () => {
  // Строка с чужим scope может приехать из будущей версии схемы. Пусть лучше её просто
  // не станет в дереве, чем чтение прав упадёт целиком.
  const p = rulesToPermissions([
    { scope: 'выдуманный', subject: 'x', item_id: '', effect: 'allow' },
    { scope: 'module', subject: 'mailing', item_id: '', effect: 'allow' },
  ])
  assert.deepEqual(p.modules, { mailing: 'allow' })
})

test('поэлементные права аккаунтов собираются в один объект, а не затирают друг друга', () => {
  const p = rulesToPermissions([
    { scope: 'resource', subject: 'accounts', item_id: 'acc_1', effect: 'deny' },
    { scope: 'resource', subject: 'accounts', item_id: 'acc_2', effect: 'allow' },
    { scope: 'resource', subject: 'folders', item_id: 'fld_1', effect: 'allow' },
  ])
  assert.deepEqual(p.resources, { accounts: { acc_1: 'deny', acc_2: 'allow' }, folders: { fld_1: 'allow' } })
})
