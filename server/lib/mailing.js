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
 * §8.4: цель рассылки — номер ИЛИ юзернейм. Раньше принимались только номера,
 * а из юзернейма молча вырезались цифры: «user2457890» превращался в номер
 * 2457890 и сообщение уходило ПОСТОРОННЕМУ. Теперь тип определяется явно.
 *
 * @param {string[]} targets
 * @returns {{ kind:'phone'|'username', value:string, raw:string }[]} без дублей
 */
export function classifyMailingTargets(targets) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(targets) ? targets : []) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    // Юзернейм: есть буквы/подчёркивание. Ссылку t.me/... тоже принимаем.
    const handle = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '')
    if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(handle)) {
      const key = `u:${handle.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: 'username', value: handle, raw: s })
      continue
    }
    const digits = s.replace(/\D/g, '')
    if (digits.length >= 7) {
      const key = `p:${digits}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: 'phone', value: digits, raw: s })
    }
  }
  return out
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
