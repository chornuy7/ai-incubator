/**
 * ЖИВЫЕ СИГНАЛЫ КАНАЛА: активность, отклик, язык — и общий балл поверх них.
 *
 * Зачем. Раньше «рейтинг» считался на клиенте из одного числа подписчиков плюс галочка
 * «есть комментарии» (правка владельца 26.08: «минимальный рейтинг оставляем, просто свой
 * скор сделать — насколько активный канал или чат, юзеры и тд»). По подписчикам нельзя
 * отличить живой канал от мёртвого: у брошенного год назад их столько же, сколько было в
 * день последнего поста. А фильтры активности, минимума комментариев и определения языка
 * вообще ничего не делали — параметр уходил на сервер и там игнорировался.
 *
 * Здесь всё считается по РЕАЛЬНЫМ постам, которые парсер и так может забрать. Функции
 * чистые: на вход посты, на выход числа — их можно проверить тестом без сети.
 */

/** Сколько дней прошло с последнего поста. Нет постов — null (не «бесконечность»). */
function daysSince(ts, now) {
  if (!ts) return null
  return Math.max(0, (now - ts) / 86_400_000)
}

/**
 * Свести посты к нескольким числам.
 * @param {Array<{date?:number, message?:string, views?:number, replies?:{replies?:number}}>} posts
 * @param {number} now
 */
export function channelSignals(posts = [], now = Date.now()) {
  const list = (Array.isArray(posts) ? posts : []).filter(Boolean)
  // GramJS отдаёт дату в СЕКУНДАХ — умножение на 1000 забыть легко, а ошибка тихая:
  // все каналы окажутся «мёртвыми пятьдесят лет назад».
  const dates = list.map((p) => (Number(p.date) || 0) * 1000).filter(Boolean).sort((a, b) => b - a)
  const lastPostAt = dates[0] || 0
  const weekAgo = now - 7 * 86_400_000
  const monthAgo = now - 30 * 86_400_000
  const perWeek = dates.filter((d) => d >= weekAgo).length
  const perMonth = dates.filter((d) => d >= monthAgo).length
  const withReplies = list.filter((p) => Number(p?.replies?.replies) > 0)
  const comments = list.reduce((s, p) => s + (Number(p?.replies?.replies) || 0), 0)
  const views = list.reduce((s, p) => s + (Number(p?.views) || 0), 0)
  return {
    posts: list.length,
    lastPostAt,
    daysSinceLastPost: daysSince(lastPostAt, now),
    postsPerWeek: perWeek,
    postsPerMonth: perMonth,
    avgComments: list.length ? Math.round((comments / list.length) * 10) / 10 : 0,
    avgViews: list.length ? Math.round(views / list.length) : 0,
    postsWithComments: withReplies.length,
  }
}

/** Канал считается ЖИВЫМ, если постил за последние столько дней. */
export const ACTIVE_WITHIN_DAYS = 30

/** Активен ли канал сейчас. Нет постов вообще — не активен (а не «неизвестно»). */
export function isActive(signals, withinDays = ACTIVE_WITHIN_DAYS) {
  const d = signals?.daysSinceLastPost
  return d !== null && d !== undefined && d <= withinDays
}

/**
 * Балл 0–10. Складывается из четырёх вещей, и каждая объяснима вслух:
 *   размер аудитории (до 4)   — сколько людей вообще увидит;
 *   свежесть (до 3)           — жив ли канал сегодня, а не был ли жив когда-то;
 *   регулярность (до 2)       — пишут постоянно или раз в квартал;
 *   отклик (до 1)             — читают ли: комментарии и просмотры к размеру аудитории.
 *
 * Свежесть весит почти как размер намеренно: мёртвый канал на сто тысяч подписчиков для
 * работы бесполезен, а живой на тысячу — вполне.
 */
export function channelScore({ members = 0, signals = null, hasComments = false } = {}) {
  const s = signals || {}
  let score = 0

  // Аудитория: шкала логарифмическая — разница между 100 и 1000 важнее, чем между 100к и 200к.
  const m = Number(members) || 0
  if (m >= 100_000) score += 4
  else if (m >= 10_000) score += 3.5
  else if (m >= 5_000) score += 3
  else if (m >= 1_000) score += 2.5
  else if (m >= 500) score += 2
  else if (m >= 100) score += 1
  else if (m > 0) score += 0.5

  // Свежесть.
  const d = s.daysSinceLastPost
  if (d === null || d === undefined) score += 0
  else if (d <= 1) score += 3
  else if (d <= 3) score += 2.5
  else if (d <= 7) score += 2
  else if (d <= 30) score += 1
  else if (d <= 90) score += 0.5

  // Регулярность.
  if (s.postsPerWeek >= 7) score += 2
  else if (s.postsPerWeek >= 3) score += 1.5
  else if (s.postsPerWeek >= 1) score += 1
  else if (s.postsPerMonth >= 1) score += 0.5

  // Отклик: комментарии важнее просмотров — они требуют усилия от читателя.
  if (s.avgComments >= 5) score += 1
  else if (s.avgComments >= 1) score += 0.6
  else if (hasComments) score += 0.3
  else if (s.avgViews && m && s.avgViews / m >= 0.2) score += 0.3

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10))
}

/** Расшифровка балла словами — чтобы цифра не выглядела взятой с потолка. */
export function explainScore({ members = 0, signals = null } = {}) {
  const s = signals || {}
  const parts = [`${members || 0} подписчиков`]
  if (s.daysSinceLastPost === null || s.daysSinceLastPost === undefined) parts.push('постов не видно')
  else if (s.daysSinceLastPost <= 1) parts.push('пост сегодня')
  else parts.push(`последний пост ${Math.round(s.daysSinceLastPost)} дн. назад`)
  if (s.postsPerWeek) parts.push(`${s.postsPerWeek} постов за неделю`)
  if (s.avgComments) parts.push(`${s.avgComments} комментариев на пост`)
  return parts.join(' · ')
}

/**
 * Язык канала по тексту постов.
 *
 * Без словарей и без сети: считаем буквы. Кириллица против латиницы даёт первое деление,
 * а внутри кириллицы украинский и русский надёжно различают четыре буквы, которых нет в
 * соседнем алфавите. Этого достаточно для пометки «на каком языке канал» — и это ровно
 * то, что просили: не перевод, а подпись.
 */
export function detectLang(texts = []) {
  const t = (Array.isArray(texts) ? texts : [texts]).join(' ').toLowerCase()
  if (!t.trim()) return null
  const cyr = (t.match(/[а-яёіїєґ]/g) || []).length
  const lat = (t.match(/[a-z]/g) || []).length
  if (cyr + lat < 10) return null // слишком мало текста, чтобы утверждать
  if (cyr > lat) {
    const ua = (t.match(/[іїєґ]/g) || []).length
    const ru = (t.match(/[ыъэё]/g) || []).length
    if (ua > ru) return 'uk'
    if (ru > ua) return 'ru'
    return 'ru'
  }
  return 'en'
}
