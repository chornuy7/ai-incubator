/** Множители задержек по уровню защиты: 0=консерв., 1=баланс, 2=агрессив. */
const LEVEL_MUL = [1.8, 1, 0.75]
const PRESET_MUL = [0.6, 1, 1.8]

const SKIP_STATUSES = new Set(['quarantine', 'spamblock', 'invalid', 'frozen', 'reauth'])

/** @param {number} level @param {number} preset */
export function delayMultiplier(level, preset) {
  return (LEVEL_MUL[level] ?? 1) * (PRESET_MUL[preset] ?? 1)
}

/** @param {number} from @param {number} [to] @param {number} mul */
export function pickDelay(from, to, mul = 1) {
  const lo = Math.max(5, Math.round(from * mul))
  const hi = Math.max(lo, Math.round((to ?? from) * mul))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/** @param {number} probability @param {boolean} aiProtection @param {number} level */
export function effectiveProbability(probability, aiProtection, level) {
  let p = probability
  if (aiProtection) {
    if (level === 0) p = Math.min(p, 25)
    else if (level === 1) p = Math.min(p, 45)
  }
  return p
}

/** @param {string} status */
export function isAccountRunnable(status) {
  return !SKIP_STATUSES.has(status)
}

/** @param {object} settings @param {number} accountComments */
export function accountLimitReached(settings, accountComments) {
  const max = settings.maxPerAccount || 0
  return max > 0 && accountComments >= max
}

/** @param {string} text @param {number} minWords */
export function postMeetsMinWords(text, minWords) {
  if (!minWords) return true
  const words = (text || '').trim().split(/\s+/).filter(Boolean)
  return words.length >= minWords
}

/** @param {string} text @param {string[]} keywords */
export function postMatchesKeywords(text, keywords) {
  if (!keywords?.length) return true
  const lower = (text || '').toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** @param {unknown} err */
export function extractFloodSeconds(err) {
  if (!err || typeof err !== 'object') return 0
  const e = /** @type {{ seconds?: number, errorMessage?: string, message?: string }} */ (err)
  if (typeof e.seconds === 'number' && e.seconds > 0) return e.seconds
  const msg = `${e.errorMessage || e.message || ''}`
  const m = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i)
  return m ? Number(m[1]) : 0
}
