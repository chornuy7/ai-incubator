/** Shared account protection — used by all module workers. */
const LEVEL_MUL = [1.8, 1, 0.75]
const PRESET_MUL = [0.6, 1, 1.8]
const SKIP_STATUSES = new Set(['quarantine', 'spamblock', 'invalid', 'frozen', 'reauth'])

export function delayMultiplier(level, preset) {
  return (LEVEL_MUL[level] ?? 1) * (PRESET_MUL[preset] ?? 1)
}

export function pickDelay(from, to, mul = 1) {
  const lo = Math.max(5, Math.round(from * mul))
  const hi = Math.max(lo, Math.round((to ?? from) * mul))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

export function effectiveProbability(probability, aiProtection, level) {
  let p = probability ?? 30
  if (aiProtection) {
    if (level === 0) p = Math.min(p, 25)
    else if (level === 1) p = Math.min(p, 45)
  }
  return p
}

export function isAccountRunnable(status) {
  return !SKIP_STATUSES.has(status)
}

export function postMeetsMinWords(text, minWords) {
  if (!minWords) return true
  return (text || '').trim().split(/\s+/).filter(Boolean).length >= minWords
}

export function postMatchesKeywords(text, keywords) {
  if (!keywords?.length) return true
  const lower = (text || '').toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function extractFloodSeconds(err) {
  if (!err || typeof err !== 'object') return 0
  const e = /** @type {{ seconds?: number, errorMessage?: string, message?: string }} */ (err)
  if (typeof e.seconds === 'number' && e.seconds > 0) return e.seconds
  const msg = `${e.errorMessage || e.message || ''}`
  const m = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i)
  return m ? Number(m[1]) : 0
}

/** @param {unknown} err */
export function mapTelegramError(err) {
  const msg = `${/** @type {{ errorMessage?: string, message?: string }} */ (err).errorMessage || /** @type {{ message?: string }} */ (err).message || ''}`
  if (msg.includes('PEER_NOT_FOUND')) return 'Контакт не найден — обновите список диалогов'
  if (msg.includes('NO_DISCUSSION') || msg.includes('MSG_ID_INVALID')) return 'Нет обсуждения у поста или комментарии недоступны'
  if (msg.includes('USER_BANNED')) return 'Аккаунт забанен'
  if (msg.includes('CHANNEL_PRIVATE')) return 'Приватный канал/группа'
  if (msg.includes('FLOOD')) return 'FloodWait'
  if (msg.includes('INVITE_REQUEST_SENT')) return 'Заявка на вступление отправлена — нужно одобрение админа'
  if (msg.includes('NOT_A_MEMBER')) return 'Аккаунт не в группе/канале — вступите или дождитесь одобрения'
  if (msg) return msg.slice(0, 120)
  return 'Ошибка Telegram'
}
