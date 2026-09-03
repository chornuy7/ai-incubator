import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mutateJson, readJson, writeJson } from '../lib/jsonStore.js'

test('mutateJson: параллельные изменения одного файла не теряются', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'))
  const file = path.join(dir, 'list.json')

  // 50 параллельных «прочитать-добавить-записать» — без сериализации часть потерялась бы.
  const N = 50
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      mutateJson(file, (arr) => { arr.push(i); return arr }, []),
    ),
  )

  const result = await readJson(file, [])
  assert.equal(result.length, N, 'ни одно изменение не должно потеряться')
  assert.deepEqual([...result].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i))
})

test('mutateJson: undefined из мутатора — запись пропускается', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'))
  const file = path.join(dir, 'x.json')
  await writeJson(file, { v: 1 })
  await mutateJson(file, () => undefined, {})
  assert.deepEqual(await readJson(file, null), { v: 1 }) // файл не тронут
})

test('mutateJson: ошибка мутатора не блокирует следующие операции над файлом', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'))
  const file = path.join(dir, 'y.json')
  await assert.rejects(() => mutateJson(file, () => { throw new Error('boom') }, []))
  // следующая операция проходит нормально
  await mutateJson(file, (arr) => { arr.push('ok'); return arr }, [])
  assert.deepEqual(await readJson(file, []), ['ok'])
})
