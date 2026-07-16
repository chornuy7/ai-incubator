import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskStore } from '../lib/taskStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const moduleKey = 'test-ts-' + Date.now()
const moduleDir = path.join(__dirname, '..', 'data', 'modules', moduleKey)

test('saveTask: обычное сохранение НЕ затирает выставленные извне stop/pause (гонка §3.9)', async () => {
  const store = createTaskStore(moduleKey, 'tt')
  try {
    const task = { id: 'tt_1', status: 'running', stopRequested: false, pauseRequested: false }
    await store.saveTask(task)
    assert.equal((await store.loadTask('tt_1')).stopRequested, false)

    // Внешняя команда «стоп» (control:true имеет право менять флаги).
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: true }, { control: true })
    assert.equal((await store.loadTask('tt_1')).stopRequested, true)

    // Воркер сохраняет прогресс с stopRequested:false — флаг с диска должен СОХРАНИТЬСЯ.
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: false, progress: { done: 5 } })
    const afterWorkerSave = await store.loadTask('tt_1')
    assert.equal(afterWorkerSave.stopRequested, true, 'stopRequested не должен затираться обычным save')
    assert.equal(afterWorkerSave.progress.done, 5)

    // Возобновление (control:true) со stopRequested:false — флаг сбрасывается.
    await store.saveTask({ id: 'tt_1', status: 'running', stopRequested: false }, { control: true })
    assert.equal((await store.loadTask('tt_1')).stopRequested, false)
  } finally {
    await fs.rm(moduleDir, { recursive: true, force: true })
  }
})

test('loadTask: несуществующая задача → null', async () => {
  const store = createTaskStore(moduleKey + '-x', 'tt')
  const r = await store.loadTask('nope')
  assert.equal(r, null)
  await fs.rm(path.join(__dirname, '..', 'data', 'modules', moduleKey + '-x'), { recursive: true, force: true })
})
