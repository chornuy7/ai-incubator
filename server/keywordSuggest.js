/**
 * Подсказка ключевых слов для парсера каналов (просьба владельца 26.08).
 *
 * До этого блок «ИИ-предложенные ключевые слова» был декорацией: список лежал
 * зашитым в конфиге витрины (`aiKeywords` в src/shared/config/modules.ts) и не
 * зависел от того, что человек ввёл, а проценты рядом были выдуманы. Здесь —
 * настоящая подсказка из двух независимых источников:
 *
 *   1. `intentVariants` — шаблоны намерения. Без ИИ, мгновенно и бесплатно.
 *      По слову «массаж» находятся каналы ПРО массаж, а по «ищу массажиста» —
 *      люди, которые уже готовы платить. Для поиска лидов второе ценнее.
 *   2. `aiVariants` — синонимы и переводы от модели: как люди на самом деле
 *      пишут это слово в Telegram.
 *
 * Процентов «релевантности» здесь намеренно нет: измерить их нечем, а
 * нарисованное число выглядит как знание, которого у нас нет. Вместо него
 * наружу отдаётся источник (`src`) и слово-родитель (`from`).
 */

const MAX_INPUT = 30 // сколько слов из списка вообще берём в работу — потолок цены запроса

/**
 * Украинские окончания, по которым слово узнаётся без букв і/ї/є/ґ: «програмування»
 * пишется одними общими с русским буквами, и по алфавиту его от русского не отличить.
 * Привязка к концу слова обязательна — иначе русское «осенняя» содержит «ння» внутри
 * и уехало бы в украинские шаблоны.
 */
const UK_TAIL = /(ння|ття|ування|ощі|ості)$/

/**
 * Язык короткого слова. `detectLang` из channelScore не годится: он требует
 * минимум 10 букв, чтобы не гадать по обрывку, а тут на входе одно слово.
 */
export function langOfWord(word = '') {
  const t = String(word).toLowerCase()
  const ua = (t.match(/[іїєґ]/g) || []).length
  const cyr = (t.match(/[а-яёіїєґ]/g) || []).length
  const lat = (t.match(/[a-z]/g) || []).length
  if (!cyr && !lat) return null
  if (cyr > lat) return ua || UK_TAIL.test(t) ? 'uk' : 'ru'
  return 'en'
}

/**
 * Шаблоны намерения. Все — без согласования по роду: «нужен массаж», но
 * «нужнА доставка», а морфологии у нас нет, поэтому «нужен/требуется» из
 * русского и украинского наборов выброшены. В английском согласования нет,
 * поэтому там «need» оставлен.
 */
const INTENT = {
  ru: ['ищу %s', 'посоветуйте %s', '%s заказать', '%s под ключ', '%s цена', 'где %s'],
  uk: ['шукаю %s', 'порадьте %s', '%s замовити', '%s під ключ', '%s ціна', 'де %s'],
  // Порядок важен: берутся первые `perWord` штук, поэтому впереди те, что подходят
  // любому слову. «hire» уместен для услуг и людей, но «hire bitcoin» — бессмыслица,
  // поэтому он в хвосте и в подсказку попадает, только если попросили больше вариантов.
  en: ['looking for %s', 'need %s', '%s services', 'best %s', '%s price', 'hire %s'],
}

/** Слово уже само по себе намерение — второй раз обвешивать его нельзя. */
const ALREADY_INTENT = /(^|\s)(ищу|нужен|нужна|нужно|нужны|требуется|посоветуйте|где|заказать|создать|сделать|купить|шукаю|потрібен|потрібна|порадьте|замовити|створити|зробити|купити|де|looking|need|hire|best|want|make|build|create|buy|services?)(\s|$)/i

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Наши варианты: шаблоны намерения по каждому слову. Работают без ключа OpenAI
 * и без сети, поэтому это же — честный запасной вариант, когда ИИ недоступен.
 */
export function intentVariants(keywords = [], { perWord = 3 } = {}) {
  const have = new Set(keywords.map(norm))
  const out = []
  const seen = new Set()
  for (const raw of keywords.slice(0, MAX_INPUT)) {
    const word = String(raw || '').trim()
    if (!word || ALREADY_INTENT.test(word)) continue // «нужен разработчик» → «ищу нужен разработчик» не нужно
    const lang = langOfWord(word)
    const tpl = INTENT[lang]
    if (!tpl) continue
    let added = 0
    for (const t of tpl) {
      if (added >= perWord) break
      const w = t.replace('%s', word)
      const k = norm(w)
      if (have.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push({ w, from: word, src: 'intent', why: 'запрос с намерением — ищет людей, а не тематику' })
      added += 1
    }
  }
  return out
}

function classifyOpenAiError(status, body = '') {
  if (status === 401) return 'ключ OpenAI не принят (401)'
  if (status === 404) return 'модель недоступна для этого ключа (404) — проверьте OPENAI_MODEL'
  if (status === 429) return 'лимит OpenAI исчерпан (429)'
  return `OpenAI ответил ${status}${body ? `: ${body.slice(0, 120)}` : ''}`
}

/**
 * Варианты от модели: по `perWord` синонимов на каждое слово в ЕГО языке плюс
 * перевод на остальные языки, которые уже есть в списке (список у владельца
 * смешанный: ru + uk + en, и ловить надо на всех трёх).
 *
 * @returns {{items:Array, mode:'openai'|'off'|'error', reason?:string, usage?:object}}
 */
export async function aiVariants(keywords = [], { perWord = 2 } = {}) {
  const words = keywords.map((w) => String(w || '').trim()).filter(Boolean).slice(0, MAX_INPUT)
  if (!words.length) return { items: [], mode: 'off', reason: 'Список ключевых слов пуст' }
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return { items: [], mode: 'off', reason: 'Ключ OpenAI не настроен — доступны только наши шаблоны' }

  const langs = [...new Set(words.map(langOfWord).filter(Boolean))]
  const system = [
    'Ты помогаешь подобрать поисковые запросы для поиска Telegram-каналов и чатов.',
    `Для КАЖДОГО слова из списка дай ровно ${perWord} синонима или близких запроса на ТОМ ЖЕ языке,`,
    langs.length > 1 ? `и по одному переводу на каждый из языков: ${langs.join(', ')}.` : '',
    'Пиши так, как люди реально называют это в Telegram: коротко, 1–3 слова, без хэштегов и знаков препинания.',
    'Не повторяй исходные слова и не выдумывай несуществующие термины.',
    'Ответ — только JSON: {"items":[{"from":"исходное слово","w":"вариант","kind":"synonym|translation"}]}',
  ].filter(Boolean).join(' ')

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Список слов:\n${words.map((w) => `- ${w}`).join('\n')}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 900,
        temperature: 0.7,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const reason = classifyOpenAiError(res.status, body)
      console.warn('[keywordSuggest] OpenAI HTTP', res.status, body.slice(0, 200))
      return { items: [], mode: 'error', reason }
    }
    const data = await res.json()
    let parsed = null
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}') } catch { parsed = null }
    const raw = Array.isArray(parsed?.items) ? parsed.items : []

    // Модель просили не повторять исходные слова, но проверяем это сами:
    // просьба в промпте — не гарантия, а дубль в списке раздражает.
    const have = new Set(words.map(norm))
    const seen = new Set()
    const items = []
    for (const it of raw) {
      const w = String(it?.w || '').trim()
      const k = norm(w)
      if (!w || w.length > 60 || have.has(k) || seen.has(k)) continue
      seen.add(k)
      items.push({
        w,
        from: String(it?.from || '').trim(),
        src: 'ai',
        why: it?.kind === 'translation' ? 'перевод' : 'синоним',
      })
    }
    return {
      items,
      mode: 'openai',
      usage: {
        tokens: Number(data?.usage?.total_tokens) || 0,
        promptTokens: Number(data?.usage?.prompt_tokens) || 0,
        completionTokens: Number(data?.usage?.completion_tokens) || 0,
        model: String(data?.model || ''),
      },
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Ошибка запроса к OpenAI'
    console.warn('[keywordSuggest] OpenAI error:', reason)
    return { items: [], mode: 'error', reason }
  }
}
