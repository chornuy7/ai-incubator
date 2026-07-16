/**
 * Чистые помощники мейлинга (§8.4) — вынесены для юнит-тестов.
 */

/** Нормализовать + дедуплицировать номера: только цифры, длина ≥7. */
export function cleanMailingNumbers(targets) {
  return [...new Set(
    (Array.isArray(targets) ? targets : [])
      .map((x) => String(x).replace(/\D/g, ''))
      .filter((x) => x.length >= 7),
  )]
}

/**
 * Выбрать аккаунт для следующего номера (round-robin) с учётом суточного лимита ЛС
 * и maxPerAccount. Чистая: dm-лимит передаётся предикатом isDmReached.
 * @param {string[]} usable @param {number} startIdx
 * @param {{ perAccSent?: Record<string,number>, maxPerAccount?: number, isDmReached?: (id:string)=>boolean }} opts
 * @returns {{ account: string|null, idx: number }}
 */
export function pickMailingAccount(usable, startIdx, opts = {}) {
  const { perAccSent = {}, maxPerAccount = 0, isDmReached = () => false } = opts
  const list = Array.isArray(usable) ? usable : []
  for (let k = 0; k < list.length; k++) {
    const cand = list[(startIdx + k) % list.length]
    if (isDmReached(cand)) continue
    if (maxPerAccount > 0 && (perAccSent[cand] || 0) >= maxPerAccount) continue
    return { account: cand, idx: (startIdx + k + 1) % list.length }
  }
  return { account: null, idx: startIdx }
}
