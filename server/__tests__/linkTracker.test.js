/**
 * C3 (SPEC §1.3): счётчик переходов — без него цель «200 переходов» не завершить,
 * критерий остаётся на честном слове оператора.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'links-'))
process.env.LINKS_FILE = path.join(dir, 'links.json')
process.env.LINK_HITS_FILE = path.join(dir, 'hits.jsonl')

const { createLink, registerHit, goalHits, getLinkByCode, deleteLink } = await import('../linkTracker.js')

test('C3: ссылка должна быть настоящим URL', async () => {
  await assert.rejects(() => createLink({ url: 'просто текст' }), /http/)
  await assert.rejects(() => createLink({ url: '' }), /http/)
})

test('C3: переход возвращает исходный адрес и считается', async () => {
  const link = await createLink({ url: 'https://example.com/promo', goalId: 'g1' })
  assert.equal(await registerHit(link.code, { ip: '1.1.1.1', ua: 'Chrome' }), 'https://example.com/promo')

  const after = await getLinkByCode(link.code)
  assert.equal(after.hits, 1)
  assert.equal(after.uniqueHits, 1)
})

test('C3: тот же посетитель не накручивает уникальные', async () => {
  const link = await createLink({ url: 'https://example.com/x', goalId: 'g2' })
  await registerHit(link.code, { ip: '2.2.2.2', ua: 'Safari' })
  await registerHit(link.code, { ip: '2.2.2.2', ua: 'Safari' })
  await registerHit(link.code, { ip: '3.3.3.3', ua: 'Safari' })

  const after = await getLinkByCode(link.code)
  assert.equal(after.hits, 3, 'все переходы считаем')
  assert.equal(after.uniqueHits, 2, 'а уникальных — двое')
})

test('C3: цель видит сумму по всем своим ссылкам', async () => {
  const a = await createLink({ url: 'https://example.com/a', goalId: 'g3' })
  const b = await createLink({ url: 'https://example.com/b', goalId: 'g3' })
  await registerHit(a.code, { ip: '4.4.4.4', ua: 'UA' })
  await registerHit(b.code, { ip: '5.5.5.5', ua: 'UA' })

  const s = await goalHits('g3')
  assert.equal(s.links, 2)
  assert.equal(s.hits, 2, 'иначе критерий «200 переходов» посчитать нечем')
})

test('C3: неизвестный код не редиректит никуда', async () => {
  assert.equal(await registerHit('нет-такого', {}), null)
})

test('C3: ссылку можно удалить', async () => {
  const link = await createLink({ url: 'https://example.com/del' })
  assert.equal(await deleteLink(link.id), true)
  assert.equal(await deleteLink(link.id), false, 'повторное удаление — не ошибка, а false')
})

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.LINKS_FILE
  delete process.env.LINK_HITS_FILE
})
