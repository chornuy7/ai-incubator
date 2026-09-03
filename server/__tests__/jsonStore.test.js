import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readJson, writeJson, dataPath, DATA_DIR } from '../lib/jsonStore.js'

test('readJson: отсутствующий/битый файл → fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonstore-'))
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), { a: 1 }), { a: 1 })
  await fs.writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8')
  assert.deepEqual(await readJson(path.join(dir, 'broken.json'), []), [])
})

test('writeJson → readJson: круговой рейс, атомарная запись', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonstore-'))
  const file = path.join(dir, 'sub', 'data.json') // подпапка создаётся автоматически
  const value = { name: 'тест', items: [1, 2, 3] }
  await writeJson(file, value)
  assert.deepEqual(await readJson(file, null), value)
  // временных .tmp файлов не остаётся
  const leftovers = (await fs.readdir(path.join(dir, 'sub'))).filter((f) => f.endsWith('.tmp'))
  assert.equal(leftovers.length, 0)
})

test('dataPath: путь внутри DATA_DIR', () => {
  assert.equal(dataPath('goals.json'), path.join(DATA_DIR, 'goals.json'))
})
