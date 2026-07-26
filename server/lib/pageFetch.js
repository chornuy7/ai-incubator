/**
 * Вытянуть текст веб-страницы для базы знаний.
 *
 * Зачем: модель по ссылке не ходит. Если положить в базу знаний голый URL, в промпт
 * уйдёт строка «https://…», и на вопрос «сколько стоит» агент придумает цену сам —
 * ровно то, ради чего база знаний и заводится. Поэтому текст забираем при добавлении
 * и храним рядом со ссылкой.
 *
 * Разбор намеренно простой (регулярки, без парсера DOM): нам нужен читаемый текст,
 * а не точная структура документа. Ошибки не бросаем наверх — недоступная страница
 * не повод рушить добавление остальных.
 */

/** Сколько текста берём со страницы. Дальше начинается навигация и подвал. */
export const PAGE_TEXT_MAX = 8000

/** Разрешаем только http(s): `file://` и прочее — это уже чтение чужого диска. */
export function isFetchableUrl(raw) {
  try {
    const u = new URL(String(raw).trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

/**
 * Выкинуть разметку и оставить читаемый текст.
 * @param {string} html @returns {{title: string, text: string}}
 */
export function extractText(html = '') {
  const src = String(html)
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] || '').trim()

  const text = src
    // Скрипты и стили — не контент, а мусор, который раздувает промпт.
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Блочные теги превращаем в перенос строки, иначе абзацы слипаются в кашу.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()

  return { title, text }
}

/**
 * Скачать страницу и вернуть её текст.
 * @param {string} url @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, title?:string, text?:string, reason?:string}>}
 */
export async function fetchPageText(url, timeoutMs = 12000) {
  if (!isFetchableUrl(url)) return { ok: false, reason: 'нужна ссылка http(s)' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      // Без User-Agent часть сайтов отдаёт заглушку или 403.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIIncubator/1.0)' },
    })
    if (!r.ok) return { ok: false, reason: `страница ответила ${r.status}` }
    const type = r.headers.get('content-type') || ''
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      return { ok: false, reason: `не текстовая страница (${type.split(';')[0] || 'неизвестный тип'})` }
    }
    const html = await r.text()
    const { title, text } = extractText(html)
    if (!text) return { ok: false, reason: 'на странице не нашлось текста' }
    return { ok: true, title, text: text.slice(0, PAGE_TEXT_MAX) }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'страница не ответила вовремя' : 'не удалось открыть' }
  } finally {
    clearTimeout(timer)
  }
}
