import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededTarget, resolveTotalTarget, resolvePerAccountTarget } from '../lib/targets.js'

test('seededTarget: детерминизм и границы', () => {
  const a = seededTarget(0, 10, 'task_x')
  const b = seededTarget(0, 10, 'task_x')
  assert.equal(a, b) // детерминизм по seed
  assert.ok(a >= 0 && a <= 10)
  assert.equal(seededTarget(5, 5, 'z'), 5)
})

test('resolveTotalTarget: защита от «тихого нуля» при положительном max', () => {
  // ищем task-id, на котором seededTarget(0, max) даёт 0 — их много
  let zeroSeed = null
  for (let i = 0; i < 200 && zeroSeed === null; i++) {
    if (seededTarget(0, 3, 'seed_' + i) === 0) zeroSeed = 'seed_' + i
  }
  assert.ok(zeroSeed, 'нашли seed с нулём')
  // без защиты был бы 0 → задача молча ничего не делает; теперь минимум 1
  const t = resolveTotalTarget({ maxActions: 3 }, { id: zeroSeed })
  assert.ok(t >= 1, `цель ${t} должна быть >= 1`)
  // если max=0 (безлимит/по времени) — 0 допустим
  assert.equal(resolveTotalTarget({ maxActions: 0 }, { id: zeroSeed }), 0)
})

/**
 * Цель на аккаунт не должна противоречить общей цели задачи (правка 19.08).
 *
 * Прогон 19.08: «всего 2, на аккаунт 0–2», один аккаунт. Жребий дал аккаунту 1 — он
 * сделал один комментарий, упёрся в свой лимит, и задача закрылась как «Готово» с
 * прогрессом 1/2. Два случайных числа противоречили друг другу.
 */
test('один аккаунт: его цель поднимается до общей', () => {
  const s = { maxActions: 2, minActions: 0, maxPerAccount: 2, minPerAccount: 0, accountIds: ['a'] }
  const task = { id: 'nc_577b6fdf' }
  assert.equal(resolveTotalTarget(s, task), 2)
  assert.equal(resolvePerAccountTarget(s, 'a', task), 2, 'иначе задача не дойдёт до собственной цели')
})

test('несколько аккаунтов: каждому хватает своей доли', () => {
  const s = { maxActions: 8, minActions: 8, maxPerAccount: 5, minPerAccount: 0, accountIds: ['a', 'b', 'c', 'd'] }
  const task = { id: 't-share' }
  for (const id of s.accountIds) {
    assert.ok(resolvePerAccountTarget(s, id, task) >= 2, `${id}: доля от 8 на четверых — минимум 2`)
  }
})

test('максимум на аккаунт остаётся потолком: его не перебиваем', () => {
  const s = { maxActions: 100, minActions: 100, maxPerAccount: 3, minPerAccount: 0, accountIds: ['a'] }
  const task = { id: 't-cap' }
  assert.equal(resolvePerAccountTarget(s, 'a', task), 3, 'указание оператора важнее общей цели')
})

test('лимит на аккаунт не задан — ограничения нет', () => {
  assert.equal(resolvePerAccountTarget({ maxActions: 10, accountIds: ['a'] }, 'a', { id: 'x' }), 0)
})
