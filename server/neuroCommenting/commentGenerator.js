import { getGlobalSystemPromptSync } from '../aiSettings.js'

const PROMPTS = {
  0: 'Напиши короткий позитивный комментарий к посту. 1-2 предложения, без хештегов.',
  1: 'Напиши тёплый, дружелюбный комментарий. 1-2 предложения.',
  2: 'Напиши эмоциональный отклик на пост. 1-2 предложения.',
  3: 'Задай один уместный вопрос автору по теме поста. Одно предложение.',
  4: 'Напиши краткий отзыв на пост. Одно предложение.',
  5: 'Напиши аналитический комментарий. 1-2 предложения, по делу.',
}

const FALLBACKS = [
  'Интересный пост, спасибо за материал!',
  'Согласен с мыслью, хорошо раскрыли тему.',
  'Полезно, возьму на заметку.',
  'Актуально, спасибо что поделились.',
  'Классный разбор, жду продолжения.',
]

export function isAiGenerationEnabled() {
  return Boolean(process.env.OPENAI_API_KEY?.trim())
}

/**
 * Отличить «ключ мёртв» от «временно не получилось».
 *
 * Разница принципиальная: при временном сбое шаблон — разумная подстраховка на один
 * коммент, а при мёртвом ключе он превращается в сотню отписок от живых аккаунтов
 * (прогон 21.07: 100 запланированных действий, ИИ отвалился на первом же).
 * Такое надо останавливать, а не «деградировать».
 *
 * @param {number} status HTTP-код ответа OpenAI
 * @param {string} [body] тело ответа — там лежит код ошибки
 * @returns {{ fatal:boolean, reason:string }}
 */
export function classifyOpenAiError(status, body = '') {
  if (status === 401 || status === 403) return { fatal: true, reason: 'ключ OpenAI отклонён (401/403) — проверьте OPENAI_API_KEY' }
  if (status === 404) return { fatal: true, reason: 'модель недоступна для этого ключа (404) — проверьте OPENAI_MODEL' }
  if (status === 429) {
    // 429 бывает двух сортов: кончились деньги (лечится только оплатой) и «слишком
    // часто» (пройдёт само). Первый — фатальный, второй — нет.
    return /insufficient_quota|exceeded your current quota|billing/i.test(body)
      ? { fatal: true, reason: 'на ключе OpenAI закончилась квота (insufficient_quota) — задача остановлена' }
      : { fatal: false, reason: 'OpenAI просит сбавить темп (429)' }
  }
  return { fatal: false, reason: `OpenAI ответил HTTP ${status}` }
}

/**
 * @param {string} postText
 * @param {number} promptIndex
 * @param {string} [systemPrompt]
 * @param {{avoid?:string[], variantSeed?:string}|string} [opts] Объект ИЛИ строка
 *   variantSeed (id аккаунта) — обратная совместимость. `avoid` — уже отправленные
 *   тексты в задаче; `variantSeed` — чтобы шаблон отличался у разных аккаунтов.
 * @returns {Promise<{ text:string|null, mode:'openai'|'template_no_key'|'template_api_error'|'fatal', reason?:string }>}
 */
/**
 * Снять служебный ярлык, который модель приписывает перед самим текстом.
 *
 * Живой прогон 22.08: в канал ушло «Комментарий: Сообщение содержит лишь тестовый текст…».
 * Так человек не пишет — по одному этому префиксу видно, что комментарий машинный, а
 * промпт («Напиши короткий комментарий к посту») модель охотно повторяет заголовком.
 * Чистим слоями, как в диалогах (`cleanDialogReply`): модель повторяет то ярлык, то
 * кавычки, то оба сразу.
 */
export function cleanCommentText(raw) {
  let s = String(raw ?? '').trim()
  for (let i = 0; i < 3; i += 1) {
    const before = s
    // Текст, целиком обёрнутый в кавычки, — тоже почерк модели, а не человека. Снимаем
    // ВНУТРИ цикла: ярлык и кавычки приходят вперемешку («Комментарий: "Ответ: …"»), и
    // при разборе одним проходом оставалась висячая кавычка на конце.
    const m = s.match(/^[«"']([\s\S]+)[»"']$/)
    if (m && !/[«"']/.test(m[1])) s = m[1].trim()
    // «Комментарий:», «Коммент —», Comment:, «Ответ:», «Мой комментарий:»
    s = s.replace(/^\s*(мой\s+|краткий\s+|короткий\s+)?(комментарий|коммент|отклик|отзыв|ответ|comment|reply)\s*[:—–-]\s*/i, '')
    // Ярлык роли, как в диалогах.
    s = s.replace(/^\s*(я|assistant|me)\s*[:—–-]\s*/i, '')
    if (s === before) break
  }
  return s.trim()
}

export async function generateComment(postText, promptIndex = 0, systemPrompt, opts = {}) {
  const o = typeof opts === 'string' ? { variantSeed: opts } : (opts || {})
  const snippet = (postText || '').slice(0, 500)
  const system = systemPrompt?.trim() || PROMPTS[promptIndex] || PROMPTS[0]
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const avoid = new Set((o.avoid || []).map(normalizeText))

  if (apiKey) {
    // Две попытки: если ИИ выдал то же, что уже отправлено, просим ещё раз погорячее.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `Текст поста или сообщения:\n${snippet || '(пусто)'}` },
            ],
            max_tokens: 120,
            temperature: attempt ? 1.1 : 0.85,
          }),
        })
        if (res.ok) {
          const data = await res.json()
          // Чистим ДО проверки длины и до сравнения с уже отправленным: иначе один и
          // тот же текст с ярлыком и без него считался бы двумя разными.
          const text = cleanCommentText(data?.choices?.[0]?.message?.content)
          if (text && text.length >= 3 && text.length <= 400) {
            if (avoid.has(normalizeText(text)) && attempt === 0) continue // повтор — просим другой
            // C1 (§5.1): расход токенов возвращаем наружу — воркер запишет его в журнал
            // с привязкой к модулю/аккаунту/задаче. Без этого C2 нечего списывать
            // и не из чего считать курс «токен → монета».
            return {
              text,
              mode: 'openai',
              usage: {
                tokens: Number(data?.usage?.total_tokens) || 0,
                promptTokens: Number(data?.usage?.prompt_tokens) || 0,
                completionTokens: Number(data?.usage?.completion_tokens) || 0,
                model: String(data?.model || ''),
              },
            }
          }
        } else {
          const errBody = await res.text().catch(() => '')
          const { fatal, reason } = classifyOpenAiError(res.status, errBody)
          console.warn('[generateComment] OpenAI HTTP', res.status, errBody.slice(0, 200))
          // Фатальное не лечится повтором и не должно молча превращаться в шаблон.
          if (fatal) return { text: null, mode: 'fatal', reason }
          break
        }
      } catch (err) {
        console.warn('[generateComment] OpenAI error:', err instanceof Error ? err.message : err)
        break
      }
    }
  }

  return {
    text: templateComment(snippet, promptIndex, { avoid, variantSeed: o.variantSeed }),
    mode: apiKey ? 'template_api_error' : 'template_no_key',
  }
}

/** Для сравнения «тот же текст или нет»: регистр и пунктуация роли не играют. */
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Стабильный хеш строки — одинаковый вход даёт одинаковый вариант. @param {string} s */
function seedHash(s) {
  let h = 0
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Смёржить глобальный системный промпт (feature 6) с промптом карточки. @param {string} cardPrompt */
function mergeGlobalPrompt(cardPrompt) {
  const global = getGlobalSystemPromptSync().trim()
  if (!global) return cardPrompt
  if (!cardPrompt) return global
  return `${global}\n\n${cardPrompt}`
}

/** @param {Record<string, unknown>} settings */
export function resolveSystemPrompt(settings) {
  const idx = settings?.promptIndex ?? 0
  let card
  if (typeof settings?.promptText === 'string' && settings.promptText.trim()) {
    card = settings.promptText.trim()
  } else {
    const overrides = settings?.promptOverrides
    if (Array.isArray(overrides) && typeof overrides[idx] === 'string' && overrides[idx].trim()) {
      card = overrides[idx].trim()
    } else {
      card = PROMPTS[idx] || PROMPTS[0]
    }
  }
  return mergeGlobalPrompt(card)
}

/**
 * Запасной шаблон, когда ИИ недоступен (нет ключа/кончилась квота).
 *
 * Вариант выбирается детерминированно по (аккаунт + текст поста) через `variantSeed`,
 * а НЕ по promptIndex: promptIndex — настройка задачи, общая для всех аккаунтов, поэтому
 * раньше все профили под одним постом писали ДОСЛОВНО одинаковый текст (прогон 21.07,
 * сигнатура ботофермы, тест 1.3). Тот же аккаунт на том же посте — тот же вариант,
 * разные аккаунты — разные. `avoid` дополнительно пропускает уже отправленное в задаче.
 *
 * @param {string} postText
 * @param {number} promptIndex
 * @param {{ avoid?: Set<string>, variantSeed?: string }} [opts]
 */
function templateComment(postText, promptIndex, opts = {}) {
  const { avoid = new Set(), variantSeed = '' } = opts
  const text = (postText || '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const hook = words.slice(0, 5).join(' ')
  const lower = text.toLowerCase()
  // Без seed поведение прежнее (промпт-индекс) — чтобы не ломать вызовы без аккаунта.
  const variant = variantSeed ? seedHash(`${variantSeed}|${text}`) : promptIndex

  const isGreeting = !text
    || words.length <= 3
    || /^(welcome|привет|hello|hi|добр|здравств)/i.test(lower)

  if (isGreeting) {
    return pickUnused([
      'Привет! Рад быть здесь, буду следить за обновлениями.',
      'Добрый день! Спасибо, что добавили в чат.',
      'Круто, что чат живёт — интересно, что дальше будет.',
      'Приветствую! Есть планы по ближайшим апдейтам?',
      'Здорово познакомиться с проектом, спасибо за welcome.',
      'Привет! Выглядит перспективно, буду на связи.',
    ], avoid, [], variant)
  }

  if (promptIndex === 3) return `А что думаете про «${hook.toLowerCase()}»?`
  if (promptIndex === 5) return `По теме «${hook}» — логично и по существу.`

  return pickUnused([
    `По «${hook}» — согласен, хорошая мысль.`,
    `Насчёт «${hook}» — приятно читать, спасибо.`,
    `Про «${hook}» — полезно, возьму на заметку.`,
    `«${hook}» — актуально, спасибо что поделились.`,
    `«${hook}» — коротко и по делу, понравилось.`,
    `По «${hook}» — интересный угол, жду продолжения.`,
  ], avoid, FALLBACKS, variant)
}

/**
 * Выбрать вариант, которого ещё не было (avoid), детерминированно по `variant`.
 * Тот же variant (аккаунт+пост) → тот же текст; разные аккаунты → разные. Если все
 * уже использованы — берём из запасного списка, потом сдаёмся и повторяемся.
 * @param {string[]} list @param {Set<string>} avoid @param {string[]} [spare] @param {number} [variant]
 */
function pickUnused(list, avoid = new Set(), spare = [], variant = 0) {
  const fresh = [...list, ...spare].filter((v) => !avoid.has(normalizeText(v)))
  const pool = fresh.length ? fresh : list
  return pool[Math.abs(variant) % pool.length]
}
