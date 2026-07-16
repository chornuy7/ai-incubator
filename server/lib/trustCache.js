/**
 * Кэш trust score по аккаунтам (§3.3). Пишется при расчёте в buildAccountStats,
 * читается дёшево там, где полный расчёт (сеть/активность) не по карману:
 *  - assignment-gate: не пускать аккаунты с trust<40 в боевые модули (авто-стоп §6);
 *  - индикатор trust в списке аккаунтов.
 * Отдельный стор (а не meta), чтобы не дёргать updatedAt/lastSeen аккаунта.
 */
import { dataPath, readJson, writeJson } from './jsonStore.js'

const FILE = process.env.TRUST_CACHE_FILE || dataPath('trust-cache.json')

export async function getAllTrustCache() {
  const m = await readJson(FILE, {})
  return m && typeof m === 'object' ? m : {}
}

export async function getTrustCache(accountId) {
  if (!accountId) return null
  return (await getAllTrustCache())[accountId] || null
}

export async function setTrustCache(accountId, { score, band }, now = Date.now()) {
  if (!accountId) return
  const m = await getAllTrustCache()
  m[accountId] = { score, band, checkedAt: now }
  await writeJson(FILE, m)
}
