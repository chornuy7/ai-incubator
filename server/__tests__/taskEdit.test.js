import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEditTask, pickEditableSettings, EDITABLE_TASK_FIELDS } from '../lib/taskEdit.js'

// Правило пересмотрено на звонке 12.08: править нельзя ТОЛЬКО живую задачу. Всё, что не
// бежит (пауза, остановлена, завершена, ошибка), править можно — заказчик прямым текстом:
// «почему я не могу редактировать задачу, которая у меня остановлена?».
test('canEditTask: правка запрещена только у живой задачи', () => {
  for (const st of ['paused', 'stopped', 'done', 'error']) {
    assert.equal(canEditTask(st).ok, true, `${st} должен быть редактируемым`)
  }

  // Работающая — отказ с внятной причиной: часть аккаунтов уже отработала по старым
  // настройкам, и смешанный результат объяснить нельзя.
  for (const st of ['running', 'queued']) {
    const r = canEditTask(st)
    assert.equal(r.ok, false, `${st} править нельзя`)
    assert.match(r.reason, /выполняется/i)
    assert.match(r.reason, /пауз|останов/i, 'причина должна подсказывать, что сделать')
  }
})

test('pickEditableSettings: пропускает разрешённые поля, включая состав аккаунтов', () => {
  const { settings, rejected } = pickEditableSettings({
    targets: ['@a', '@b'],
    maxActions: 10,
    delays: { action: [5, 10] },
    accountIds: ['acc1'], // звонок 12.08: состав исполнителей меняется внутри задачи
    status: 'done',       // статусом через правку настроек по-прежнему не крутим
  })
  assert.deepEqual(settings.targets, ['@a', '@b'])
  assert.equal(settings.maxActions, 10)
  assert.deepEqual(settings.delays, { action: [5, 10] })
  assert.deepEqual(settings.accountIds, ['acc1'], 'accountIds теперь редактируемый')
  assert.deepEqual(rejected, ['status'], 'служебные поля мимо правки настроек')
})

test('pickEditableSettings: undefined не затирает существующее значение', () => {
  const { settings } = pickEditableSettings({ targets: undefined, maxActions: 0 })
  assert.equal('targets' in settings, false, 'undefined не должен попадать в патч')
  assert.equal(settings.maxActions, 0, 'ноль — валидное значение, не путать с undefined')
})

test('accountIds входит в разрешённые поля (смена исполнителей внутри задачи)', () => {
  assert.equal(EDITABLE_TASK_FIELDS.includes('accountIds'), true)
})
