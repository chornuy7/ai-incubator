/**
 * §8.1: роль «без оплаты» (тест/модератор). Флаг freeAccess переживает нормализацию
 * роли (иначе он терялся бы при сохранении), по умолчанию выключен.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRole } from '../roles.js'

test('normalizeRole сохраняет freeAccess=true', () => {
  const r = normalizeRole({ name: 'Тест-доступ', permissions: { freeAccess: true, modules: {}, blocks: {}, sections: {}, resources: {} } })
  assert.equal(r.permissions.freeAccess, true)
})

test('по умолчанию freeAccess=false, а не undefined', () => {
  const r = normalizeRole({ name: 'Обычная' })
  assert.equal(r.permissions.freeAccess, false)
})

test('freeAccess приводится к булеву (!!)', () => {
  assert.equal(normalizeRole({ name: 'x', permissions: { freeAccess: 1 } }).permissions.freeAccess, true)
  assert.equal(normalizeRole({ name: 'x', permissions: { freeAccess: 0 } }).permissions.freeAccess, false)
})

/**
 * Владелец без роли (обычная самостоятельная регистрация) должен видеть то, что купил.
 *
 * Баг 18.08: сервер отдавал таким `permissions: null` со смыслом «не ограничен», а
 * клиентский `can(null, …)` читает null как «прав нет». Человек оплачивал модули,
 * на странице подписок горело «оплачен», а в меню не было ничего.
 */
test('роль-less владелец получает явные права, а не null', async () => {
  const { unrestrictedPermissions } = await import('../roles.js')
  const { listModuleKeys } = await import('../modules/registry.js')
  const keys = listModuleKeys()
  const p = unrestrictedPermissions(keys)

  for (const k of keys) assert.equal(p.modules[k], 'allow', `модуль ${k} должен быть открыт владельцу`)
  assert.equal(p.sections['/panel/tasks'], 'allow', 'разделы панели тоже открыты')
  assert.equal(p.resources.allTasks, 'allow', 'свои задачи владелец видит все')
  // Блоки именуются «модуль:блок» — плоские ключи не совпадали ни с чем, и страница
  // модуля встречала владельца текстом «не выдан ни один блок».
  for (const k of keys) {
    assert.equal(p.blocks[`${k}:run`], 'allow', `блок запуска у ${k} должен быть открыт`)
    assert.equal(p.blocks[`${k}:settings`], 'allow', `настройки у ${k} должны быть открыты`)
  }
  assert.equal(p.blocks.run, undefined, 'плоских ключей быть не должно — их никто не читает')
})

test('суб без роли прав НЕ получает — доступ выдаёт владелец', async () => {
  const { mergePermissions } = await import('../roles.js')
  const empty = mergePermissions([])
  assert.deepEqual(empty.modules, {}, 'сотруднику без роли модули не открываются')
  assert.equal(empty.resources.allTasks, 'deny')
})
