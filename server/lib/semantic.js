/**
 * Семантическая релевантность к цели (§3.5): embeddings + косинусная близость.
 * Позволяет комментировать/отвечать только по постам, реально близким к цели кампании,
 * а не только по стоп-словам. Опционально (opt-in `semanticFilter`), требует OPENAI_API_KEY.
 * Чистые cosine/rank юнит-тестируются; embedText — сетевой вызов OpenAI.
 */
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'

/** Доступна ли семантика (есть ключ OpenAI). */
export function isSemanticEnabled() {
  return Boolean(process.env.OPENAI_API_KEY?.trim())
}

/** Косинусная близость двух векторов [-1..1]. Чистая. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Отранжировать/отфильтровать элементы по близости их вектора к запросу. Чистая.
 * @param {T[]} items @param {number[]} queryVec @param {(it:T)=>number[]} getVec @param {number} [minScore]
 * @template T @returns {{item:T, score:number}[]} по убыванию близости
 */
export function rankBySimilarity(items, queryVec, getVec, minScore = 0) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({ item: it, score: cosineSimilarity(getVec(it) || [], queryVec || []) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
}

/** Embedding текста через OpenAI. @returns {Promise<number[]|null>} null при ошибке/без ключа. */
export async function embedText(text, userId) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const input = String(text || '').trim().slice(0, 8000)
  if (!apiKey || !input) return null
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    })
    if (!res.ok) {
      console.warn('[embedText] OpenAI HTTP', res.status, (await res.text().catch(() => '')).slice(0, 160))
      return null
    }
    const data = await res.json()
    // Эмбеддинги дешевле генерации, но не бесплатны: раньше семантический фильтр
    // тратил деньги мимо журнала — и «сколько ушло на задачу» считалось неверно.
    const { noteUsage } = await import('../tokenLedger.js')
    await noteUsage(data?.usage, 'semantic', userId)
    const vec = data?.data?.[0]?.embedding
    return Array.isArray(vec) ? vec : null
  } catch (err) {
    console.warn('[embedText] error:', err instanceof Error ? err.message : err)
    return null
  }
}
