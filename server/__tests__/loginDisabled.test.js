/**
 * Отключённому пользователю на вход нельзя отвечать «неверный e-mail или пароль».
 *
 * Созвон 17.08: владелец выключил себе доступ, попробовал войти и получил «неверный
 * пароль». Пароль был верный — по такому ответу человек идёт его восстанавливать и
 * упирается в стену, вместо того чтобы написать администратору.
 *
 * Живой путь входа требует настроенного Supabase Auth, поэтому проверяем ту часть, где
 * принимается решение: пароль уже сошёлся, дальше смотрим на профиль и на оператора.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessReason } from '../users.js'

test('выключенный профиль — это «отключён», а не «неверный пароль»', () => {
  assert.equal(accessReason({ active: false, legacy_id: 'usr_1' }, null), 'disabled')
  assert.equal(accessReason({ active: false }, { active: true }), 'disabled', 'профиль главнее: доступ снят в нём')
})

test('выключенный оператор — тоже «отключён»', () => {
  assert.equal(accessReason(null, { active: false }), 'disabled')
  assert.equal(accessReason({ active: true }, { active: false }), 'disabled')
})

test('нет такого оператора — «неверный пароль», без подсказок о чужих аккаунтах', () => {
  assert.equal(accessReason(null, null), 'bad')
  assert.equal(accessReason({ active: true }, null), 'bad')
})

test('всё в порядке — причины отказа нет', () => {
  assert.equal(accessReason({ active: true, legacy_id: 'usr_1' }, { active: true }), null)
  assert.equal(accessReason(null, { active: true }), null, 'профиля может не быть — решает оператор')
})
