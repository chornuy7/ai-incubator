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
