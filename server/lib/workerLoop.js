/**
 * План прогрева по уровню (§8.2). 0 = Быстрый (2 дня, интенсивнее), 1 = Нормальный (3–7),
 * 2 = Стандартный (7–14, мягче/естественнее). Чистая функция.
 * `mul` — множитель задержек (длиннее уровень → медленнее темп); `actionsPerDay` — ориентир
 * дневной активности на аккаунт. @param {number} level
 * @returns {{ level:number, label:string, mul:number, actionsPerDay:number }}
 */
export function warmingPace(level) {
  const plans = [
    { level: 0, label: 'Быстрый (2 дня)', mul: 0.8, actionsPerDay: 40 },
    { level: 1, label: 'Нормальный (3–7 дней)', mul: 1.3, actionsPerDay: 20 },
    { level: 2, label: 'Стандартный (7–14 дней)', mul: 2.0, actionsPerDay: 10 },
  ]
  return plans[level] || plans[1]
}

/** @param {object} task @param {boolean} progressed @param {number} [maxIdle] */
export function trackIdlePass(task, progressed, maxIdle = 5) {
  if (progressed) {
    task.idlePasses = 0
    return false
  }
  task.idlePasses = (task.idlePasses || 0) + 1
  return task.idlePasses >= maxIdle
}

/** Есть ли в тексте хотя бы одно из слов (регистронезависимо). @param {string} text @param {string[]} words */
export function postContainsAny(text, words) {
  if (!words?.length) return false
  const lower = (text || '').toLowerCase()
  return words.some((w) => { const t = String(w).trim().toLowerCase(); return t && lower.includes(t) })
}

/** @param {object[]} posts @param {object} settings */
export function pickCommentCandidates(posts, settings) {
  const textOf = (p) => (p.message || '').trim() || (p.media ? '[медиа]' : '')
  let candidates = posts.filter((p) => postMeetsMinWords(textOf(p), settings.minWords || 0))
  if (settings.commentMode === 1) {
    candidates = candidates.filter((p) => postMatchesKeywords(textOf(p), settings.keywords || []))
  }
  // §3.5 семантика/тональность (фильтр): пропускаем посты со стоп-словами (нежелательные темы/тон).
  if (settings.stopWords?.length) {
    candidates = candidates.filter((p) => !postContainsAny(textOf(p), settings.stopWords))
  }
  const postFilter = settings.postFilter ?? 0
  if (postFilter === 0 && candidates.length) {
    const newest = Math.max(...candidates.map((p) => p.id))
    candidates = candidates.filter((p) => p.id === newest)
  } else if (postFilter === 1 && candidates.length) {
    const newest = Math.max(...posts.map((x) => x.id))
    candidates = candidates.filter((p) => p.id !== newest)
  }
  if (settings.commentMode === 0 && candidates.length > 1) {
    candidates = [candidates[Math.floor(Math.random() * candidates.length)]]
  }
  return candidates
}

function postMeetsMinWords(text, minWords) {
  if (!minWords) return true
  return (text || '').trim().split(/\s+/).filter(Boolean).length >= minWords
}

function postMatchesKeywords(text, keywords) {
  if (!keywords?.length) return true
  const lower = (text || '').toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}
