import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEditTask, pickEditableSettings, EDITABLE_TASK_FIELDS } from '../lib/taskEdit.js'

test('§9.8 canEditTask: править можно только на паузе', () => {
  assert.equal(canEditTask('paused').ok, true)

  // Работающая задача — отказ с внятной причиной (воркер уже прошёл часть аккаунтов).
  const running = canEditTask('running')
  assert.equal(running.ok, false)
  assert.match(running.reason, /только на паузе/i)
  assert.equal(canEditTask('queued').ok, false)

  // Завершённая — править нечего.
  for (const st of ['done', 'stopped', 'error']) {
    const r = canEditTask(st)
    assert.equal(r.ok, false, `${st} не должен быть редактируемым`)
    assert.match(r.reason, /завершена/i)
  }
})

test('§9.8 pickEditableSettings: пропускает только разрешённые поля', () => {
  const { settings, rejected } = pickEditableSettings({
    targets: ['@a', '@b'],
    maxActions: 10,
    delays: { action: [5, 10] },
    accountIds: ['acc1'], // менять исполнителей нельзя — за задачей висят локи
    status: 'done', // статусом через правку настроек тоже не крутим
  })
  assert.deepEqual(settings.targets, ['@a', '@b'])
  assert.equal(settings.maxActions, 10)
  assert.deepEqual(settings.delays, { action: [5, 10] })
  assert.equal(settings.accountIds, undefined, 'accountIds не должен проходить')
  assert.deepEqual(rejected.sort(), ['accountIds', 'status'])
})

test('§9.8 pickEditableSettings: undefined не затирает существующее значение', () => {
  const { settings } = pickEditableSettings({ targets: undefined, maxActions: 0 })
  assert.equal('targets' in settings, false, 'undefined не должен попадать в патч')
  assert.equal(settings.maxActions, 0, 'ноль — валидное значение, не путать с undefined')
})

test('§9.8 accountIds отсутствует в списке разрешённых полей (защита от регрессии)', () => {
  assert.equal(EDITABLE_TASK_FIELDS.includes('accountIds'), false)
})
