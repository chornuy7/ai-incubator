/**
 * Trust score аккаунта (§3.3, решение §6 DECISIONS-06). Взвешенная оценка «здоровья»
 * для авто-стопа/возврата в пул. Формула и пороги — из решения заказчика:
 *
 *   FloodWait за 24ч — 40% · история spamblock/quarantine — 25% ·
 *   действия без блока — 15% · возраст/GGR — 20%.
 *   Пороги: <40 → авто-стоп + прогрев; 40–70 → только Консервативный режим; >70 → в пул.
 *
 * Модуль чистый (без I/O) — целиком юнит-тестируется. Извлечение сигналов из активности —
 * отдельная функция extractTrustSignals (тоже чистая, на вход — уже собранные данные).
 */

const WEIGHTS = { flood: 0.40, bans: 0.25, actions: 0.15, age: 0.20 }

const clamp = (n) => Math.max(0, Math.min(100, n))

/**
 * Посчитать trust score из нормализованных сигналов.
 * @param {object} s
 * @param {number} s.floodWaits24h  — сколько FloodWait за последние 24ч
 * @param {number} s.banHistory     — число событий spamblock/quarantine в истории
 * @param {number} [s.statusPenalty] — штраф за текущий плохой статус (0..100)
 * @param {number} s.cleanActions   — успешные действия без блокировок (сигнал доверия)
 * @param {number} s.ageDays        — возраст аккаунта в днях
 * @param {number|null} [s.ggr]      — GGR (если считается); null → компонент только по возрасту
 * @returns {{score:number, band:'low'|'mid'|'high', parts:object}}
 */
export function computeTrustScore(s = {}) {
  const floodWaits24h = Math.max(0, Number(s.floodWaits24h || 0))
  const banHistory = Math.max(0, Number(s.banHistory || 0))
  const statusPenalty = Math.max(0, Number(s.statusPenalty || 0))
  const cleanActions = Math.max(0, Number(s.cleanActions || 0))
  const ageDays = Math.max(0, Number(s.ageDays || 0))
  const ggr = s.ggr == null ? null : Math.max(0, Number(s.ggr))

  // Каждый сигнал → 0..100 (100 = лучше всего).
  const sFlood = clamp(100 - floodWaits24h * 25) // 0 флудов → 100; 4+ → 0
  const sBans = clamp(100 - banHistory * 30 - statusPenalty) // история + текущий статус
  const sActions = clamp((cleanActions / 20) * 100) // 20 чистых действий → полное доверие
  let sAge = clamp((ageDays / 30) * 100) // 30 дней → 100
  if (ggr != null) sAge = clamp(sAge * 0.6 + clamp(ggr) * 0.4) // GGR калибруется (§6) — мягкий блендинг

  const score = Math.round(
    WEIGHTS.flood * sFlood + WEIGHTS.bans * sBans + WEIGHTS.actions * sActions + WEIGHTS.age * sAge,
  )
  return { score, band: trustBand(score), parts: { flood: Math.round(sFlood), bans: Math.round(sBans), actions: Math.round(sActions), age: Math.round(sAge) } }
}

/** Полоса доверия по порогам §6: <40 low · 40–70 mid · >70 high. */
export function trustBand(score) {
  if (score < 40) return 'low'
  if (score > 70) return 'high'
  return 'mid'
}

/**
 * Рекомендация по полосе (что делать с аккаунтом).
 * @returns {{band, action:'autostop'|'conservative'|'pool', label:string, hint:string}}
 */
export function trustRecommendation(score) {
  const band = trustBand(score)
  if (band === 'low') return { band, action: 'autostop', label: 'Авто-стоп → прогрев', hint: 'Низкий trust (<40): снять с работы и отправить на прогрев.' }
  if (band === 'high') return { band, action: 'pool', label: 'В пул', hint: 'Высокий trust (>70): можно брать в боевые модули.' }
  return { band, action: 'conservative', label: 'Консервативный режим', hint: 'Средний trust (40–70): работать только на «Консервативном» уровне защиты.' }
}

/**
 * Извлечь сигналы для trust из активности/меты (чистая).
 * @param {object} inp
 * @param {{type?:string,label?:string,level?:string,ts?:number}[]} inp.activity — недавние события
 * @param {string} inp.status — текущий статус аккаунта
 * @param {number} inp.ageDays
 * @param {number} [inp.now]
 * @param {number|null} [inp.ggr]
 */
export function extractTrustSignals({ activity = [], status = 'active', ageDays = 0, now = Date.now(), ggr = null } = {}) {
  const isFlood = (e) => /flood|флуд/i.test(e.label || '')
  const isBan = (e) => /spamblock|спамблок|карантин|quarantine/i.test(e.label || '')
  const floodWaits24h = activity.filter((e) => isFlood(e) && (now - (e.ts || 0)) <= 24 * 3600 * 1000).length
  const banHistory = activity.filter(isBan).length
  const cleanActions = activity.filter((e) => e.type === 'action' && e.level !== 'error').length
  const statusPenalty = status === 'spamblock' ? 60 : status === 'quarantine' ? 40 : status === 'floodwait' ? 20 : (status === 'invalid' || status === 'reauth') ? 50 : 0
  return { floodWaits24h, banHistory, statusPenalty, cleanActions, ageDays, ggr }
}

/** Полный расчёт из активности/меты: сигналы → score → рекомендация. */
export function accountTrust(inp) {
  const signals = extractTrustSignals(inp)
  const { score, band, parts } = computeTrustScore(signals)
  return { score, band, parts, signals, ...trustRecommendation(score) }
}
