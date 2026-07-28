/**
 * §10.9: мониторинг здоровья аккаунтов. Проверяем раскладку work/idle/problem и что
 * у падающих есть причина — на этом строится экран «почему аккаунт выпал».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-'))
process.env.ACCOUNTS_META_FILE = path.join(dir, 'accounts-meta.json')

const seed = {
  a1: { id: 'a1', name: 'Акк 1', status: 'active' },
  a2: { id: 'a2', name: 'Акк 2', status: 'warming' },
  a3: { id: 'a3', name: 'Акк 3', status: 'pause' },
  a4: { id: 'a4', name: 'Акк 4', status: 'floodwait', statusReason: 'FloodWait 300с', statusSince: 1000, statusUntil: Date.now() + 300000 },
  a5: { id: 'a5', name: 'Акк 5', status: 'spamblock', statusReason: 'Забанен за спам', statusSince: 2000 },
  a6: { id: 'a6', name: 'Акк 6', status: 'quarantine', statusReason: 'Карантин после FloodWait', statusSince: 3000 },
  a7: { id: 'a7', name: 'В корзине', status: 'active', inTrash: true }, // не считаем
}
await fs.writeFile(process.env.ACCOUNTS_META_FILE, JSON.stringify(seed), 'utf8')

const { accountsHealth } = await import('../adminStats.js')

test('§10.9: раскладка work/idle/problem и исключение корзины', async () => {
  const h = await accountsHealth()
  assert.equal(h.total, 6, 'аккаунт в корзине не считается')
  assert.equal(h.healthy, 2, 'active + warming работают')
  assert.equal(h.idle, 1, 'pause — на паузе')
  assert.equal(h.problem, 3, 'floodwait + spamblock + quarantine — падают')
})

test('§10.9: у каждого падающего есть статус и причина', async () => {
  const h = await accountsHealth()
  assert.equal(h.problems.length, 3)
  for (const p of h.problems) {
    assert.ok(p.reason, `${p.name}: указана причина`)
    assert.ok(p.statusLabel, `${p.name}: человекочитаемый статус`)
    assert.ok(['floodwait', 'spamblock', 'quarantine'].includes(p.status))
  }
  // Свежайшая проблема — сверху (по statusSince).
  const since = h.problems.map((p) => p.since)
  assert.deepEqual(since, [...since].sort((a, b) => b - a), 'проблемы отсортированы: свежие сверху')
})

test('§10.9: byStatus считает по каждому статусу', async () => {
  const h = await accountsHealth()
  assert.equal(h.byStatus.active, 1)
  assert.equal(h.byStatus.warming, 1)
  assert.equal(h.byStatus.pause, 1)
  assert.equal(h.byStatus.floodwait, 1)
})

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.ACCOUNTS_META_FILE
})
