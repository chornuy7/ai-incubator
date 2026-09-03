import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('trustCache: set/get + getAll', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'))
  process.env.TRUST_CACHE_FILE = path.join(dir, 't.json')
  const m = await import('../lib/trustCache.js?t=' + Date.now())
  assert.equal(await m.getTrustCache('acc1'), null)
  await m.setTrustCache('acc1', { score: 35, band: 'low' }, 111)
  await m.setTrustCache('acc2', { score: 82, band: 'high' }, 222)
  const t1 = await m.getTrustCache('acc1')
  assert.equal(t1.score, 35)
  assert.equal(t1.band, 'low')
  assert.equal(t1.checkedAt, 111)
  const all = await m.getAllTrustCache()
  assert.equal(Object.keys(all).length, 2)
  assert.equal(all.acc2.score, 82)
  assert.equal(await m.getTrustCache(null), null)
  delete process.env.TRUST_CACHE_FILE
})
