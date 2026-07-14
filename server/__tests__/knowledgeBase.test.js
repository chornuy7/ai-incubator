import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeKb } from '../knowledgeBase.js'

test('normalizeKb: дефолты и валид kind', () => {
  const k = normalizeKb({ title: '  О продукте ', content: 'текст', kind: 'wat' })
  assert.equal(k.kind, 'text') // невалидный kind → text
  assert.equal(k.title, 'О продукте')
  assert.equal(k.content, 'текст')
  assert.equal(k.scope, 'all')
  assert.equal(k.fileRef, null)
})

test('CRUD базы знаний по цели (изолированный файл)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-'))
  process.env.KB_FILE = path.join(dir, 'kb.json')
  const kb = await import('../knowledgeBase.js?crud=' + Date.now())

  assert.deepEqual(await kb.listKb('g1'), [])

  const a = await kb.createKb('g1', { title: 'Оффер', content: 'скидка 20%' })
  await kb.createKb('g1', { content: 'цена 1000' })
  await kb.createKb('g2', { content: 'другая цель' })

  assert.equal((await kb.listKb('g1')).length, 2) // по цели
  assert.equal((await kb.listKb()).length, 3) // все

  const upd = await kb.updateKb(a.id, { content: 'скидка 30%' })
  assert.equal(upd.content, 'скидка 30%')
  assert.equal(upd.version, 2) // версия растёт

  await kb.deleteKbByGoal('g1')
  assert.equal((await kb.listKb('g1')).length, 0)
  assert.equal((await kb.listKb('g2')).length, 1) // чужую цель не тронули

  delete process.env.KB_FILE
})

test('createKb без цели/пустая — ошибка', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-'))
  process.env.KB_FILE = path.join(dir, 'kb.json')
  const kb = await import('../knowledgeBase.js?err=' + Date.now())
  await assert.rejects(() => kb.createKb('', { content: 'x' }), /goalId/i)
  await assert.rejects(() => kb.createKb('g1', {}), /Пустая/i)
  delete process.env.KB_FILE
})
