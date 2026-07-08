/** @param {object} task @param {boolean} progressed @param {number} [maxIdle] */
export function trackIdlePass(task, progressed, maxIdle = 5) {
  if (progressed) {
    task.idlePasses = 0
    return false
  }
  task.idlePasses = (task.idlePasses || 0) + 1
  return task.idlePasses >= maxIdle
}

/** @param {object[]} posts @param {object} settings */
export function pickCommentCandidates(posts, settings) {
  const textOf = (p) => (p.message || '').trim() || (p.media ? '[медиа]' : '')
  let candidates = posts.filter((p) => postMeetsMinWords(textOf(p), settings.minWords || 0))
  if (settings.commentMode === 1) {
    candidates = candidates.filter((p) => postMatchesKeywords(textOf(p), settings.keywords || []))
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
