/**
 * Шаблоны настроек модулей — в общей базе, а не в файлах на сервере.
 *
 * Находка 26.08: `taskStore` писал их в `server/data/modules/<модуль>/presets.json`, ветки
 * Supabase не было. Локальная копия и сервер показывали разные наборы, второй инстанс
 * развёл бы их окончательно, и это прямо нарушало правило «только общая база».
 *
 * Здесь проверяется форма записи и то, ради чего перенос затевался: набор одного модуля
 * не задевает другой, а перезапись набора не теряет и не плодит записи.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Свежий стор модуля на временном каталоге: тесты не должны трогать боевые данные. */
async function freshStore(moduleKey = 'neuro-chatting') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presets-'))
  process.env.DATA_DIR = dir
  const { createTaskStore } = await import(`../lib/taskStore.js?t=${Date.now()}${Math.round(performance.now())}`)
  return createTaskStore(moduleKey, 'tk')
}

const preset = (over = {}) => ({
  id: `pr_${Math.round(performance.now() * 1000)}`,
  name: 'Шаблон',
  settings: { maxActions: 10, delays: { comment: [30, 120] } },
  createdAt: Date.now(),
  ...over,
})

test('пустой модуль отдаёт пустой список, а не падает', async () => {
  const store = await freshStore()
  assert.deepEqual(await store.loadPresets(), [])
})

test('сохранённый набор читается обратно тем же составом', async () => {
  const store = await freshStore()
  const a = preset({ name: 'Первый', userId: 'usr_1' })
  const b = preset({ name: 'Второй', userId: 'usr_2', color: 'red', owner: 'Коля' })
  await store.savePresets([a, b])
  const back = await store.loadPresets()
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((p) => p.name).sort(), ['Второй', 'Первый'])
})

test('настройки шаблона переживают запись целиком, а не по верхам', async () => {
  const store = await freshStore()
  const p = preset({ settings: { maxActions: 7, delays: { comment: [15, 45] }, probability: 30, prompts: ['а', 'б'] } })
  await store.savePresets([p])
  const [back] = await store.loadPresets()
  assert.deepEqual(back.settings, p.settings, 'снимок настроек должен возвращаться как есть')
})

test('владелец сохраняется — на нём держится весь владельческий фильтр', async () => {
  const store = await freshStore()
  await store.savePresets([preset({ userId: 'usr_owner' }), preset({ name: 'Легаси' })])
  const back = await store.loadPresets()
  const mine = back.find((p) => p.userId === 'usr_owner')
  const legacy = back.find((p) => p.name === 'Легаси')
  assert.ok(mine, 'шаблон с владельцем на месте')
  assert.equal(legacy.userId, undefined, 'легаси-шаблон остаётся без владельца — его видит только админ')
})

test('перезапись набора убирает то, чего в нём нет, и не плодит копии', async () => {
  const store = await freshStore()
  const a = preset({ name: 'Остаётся' })
  const b = preset({ name: 'Удаляется' })
  await store.savePresets([a, b])
  await store.savePresets([a])
  const back = await store.loadPresets()
  assert.equal(back.length, 1)
  assert.equal(back[0].name, 'Остаётся')
})

test('пустой набор очищает модуль полностью', async () => {
  const store = await freshStore()
  await store.savePresets([preset()])
  await store.savePresets([])
  assert.deepEqual(await store.loadPresets(), [])
})

test('модули не смешиваются: шаблон одного не виден в другом', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presets-'))
  process.env.DATA_DIR = dir
  const { createTaskStore } = await import(`../lib/taskStore.js?t=${Date.now()}x`)
  const a = createTaskStore('mass-react', 'tk')
  const b = createTaskStore('mass-looking', 'tk')
  await a.savePresets([preset({ name: 'Только реакции' })])
  assert.equal((await a.loadPresets()).length, 1)
  assert.deepEqual(await b.loadPresets(), [], 'соседний модуль своих шаблонов не получал')
})
