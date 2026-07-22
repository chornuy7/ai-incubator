/**
 * §9 «дожим»: человек, по которому цель закрыта, написал сам. Молчать в ответ —
 * терять самый тёплый контакт, какой бывает; писать без ограничений — донимать.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followUpDecision, followUpPrompt, followUpStatus, TERMINAL } from '../lib/followUp.js'

const goalOn = (limit = 10, instructions = '') => ({ followUp: { enabled: true, limit, instructions } })
const goalOff = { followUp: { enabled: false, limit: 10 } }

test('нетерминальный лид — обычный диалог, дожим ни при чём', () => {
  for (const status of ['cold', 'contacted', 'warm', 'interested', 'hot']) {
    assert.equal(followUpDecision({ status }, goalOn(), 0, true).mode, 'normal', status)
  }
})

test('дожим выключен — прежнее поведение: молчим со внятной причиной', () => {
  const closed = followUpDecision({ status: 'closed' }, goalOff, 0, true)
  assert.equal(closed.mode, 'skip')
  assert.match(closed.reason, /отказал/i)

  const target = followUpDecision({ status: 'target' }, goalOff, 0, true)
  assert.equal(target.mode, 'skip')
  assert.match(target.reason, /целевое действие/i)
})

test('цель достигнута + человек написал сам → дожимаем', () => {
  const d = followUpDecision({ status: 'target' }, goalOn(10), 0, true)
  assert.equal(d.mode, 'follow-up')
  assert.equal(d.left, 10)
})

test('без входящего не дожимаем — это ответ на инициативу, а не рассылка', () => {
  const d = followUpDecision({ status: 'target' }, goalOn(10), 0, false)
  assert.equal(d.mode, 'skip', 'иначе дожим станет догоняющей рассылкой')
})

test('лимит: считаем до предела и замолкаем', () => {
  const goal = goalOn(3)
  assert.equal(followUpDecision({ status: 'target' }, goal, 0, true).left, 3)
  assert.equal(followUpDecision({ status: 'target' }, goal, 2, true).mode, 'follow-up')
  const done = followUpDecision({ status: 'target' }, goal, 3, true)
  assert.equal(done.mode, 'skip')
  assert.match(done.reason, /исчерпан \(3\/3\)/)
})

test('лимит по умолчанию 10, кривое значение не ломает', () => {
  assert.equal(followUpDecision({ status: 'target' }, { followUp: { enabled: true } }, 0, true).left, 10)
  assert.equal(followUpDecision({ status: 'target' }, { followUp: { enabled: true, limit: 0 } }, 0, true).left, 10)
})

test('нет лида вообще — обычный диалог', () => {
  assert.equal(followUpDecision(null, goalOn(), 0, true).mode, 'normal')
})

test('followUpPrompt: тон разный для отказавшегося и для достигшего цели', () => {
  const afterRefusal = followUpPrompt(goalOn(), 'closed', 5)
  assert.match(afterRefusal, /ОТКАЗАЛСЯ/)
  assert.match(afterRefusal, /Не дави/)

  const afterTarget = followUpPrompt(goalOn(), 'target', 5)
  assert.match(afterTarget, /выполнил целевое действие/)
  assert.match(afterTarget, /Не продавай повторно/)

  assert.match(followUpPrompt(goalOn(10, 'Предложи консультацию'), 'target', 3), /Предложи консультацию/)
  assert.match(followUpPrompt(goalOn(), 'target', 3), /Осталось сообщений в этом режиме: 3/)
})

test('followUpStatus: отказ в дожиме закрывает лида даже после достигнутой цели', () => {
  assert.equal(followUpStatus('target', 'closed'), 'closed')
  assert.equal(followUpStatus('closed', 'closed'), null, 'уже закрыт — менять нечего')
})

test('followUpStatus: ожил после отказа — возвращаем в работу', () => {
  assert.equal(followUpStatus('closed', 'hot'), 'hot')
  assert.equal(followUpStatus('closed', 'interested'), 'interested')
  assert.equal(followUpStatus('closed', 'warm'), 'warm')
})

test('followUpStatus: достигнутую цель заново не «достигаем»', () => {
  assert.equal(followUpStatus('target', 'hot'), null)
  assert.equal(followUpStatus('target', 'target'), null)
  assert.equal(followUpStatus('target', 'warm'), null)
})

test('TERMINAL: ровно два статуса завершают диалог', () => {
  assert.deepEqual([...TERMINAL].sort(), ['closed', 'target'])
})
