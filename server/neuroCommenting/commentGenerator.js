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
 * @param {{ avoid?: string[] }} [opts] `avoid` — тексты, которые уже отправлены в этой
 *   задаче: одинаковый комментарий от разных аккаунтов под одним постом выдаёт их пачкой.
 * @returns {Promise<{ text:string|null, mode:'openai'|'template_no_key'|'template_api_error'|'fatal', reason?:string }>}
 */
export async function generateComment(postText, promptIndex = 0, systemPrompt, opts = {}) {
  const snippet = (postText || '').slice(0, 500)
  const system = systemPrompt?.trim() || PROMPTS[promptIndex] || PROMPTS[0]
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const avoid = new Set((opts.avoid || []).map(normalizeText))

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
          const text = data?.choices?.[0]?.message?.content?.trim()
          if (text && text.length >= 3 && text.length <= 400) {
            if (avoid.has(normalizeText(text)) && attempt === 0) continue // повтор — просим другой
            return { text, mode: 'openai' }
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
    text: templateComment(snippet, promptIndex, avoid),
    mode: apiKey ? 'template_api_error' : 'template_no_key',
  }
}

/** Для сравнения «тот же текст или нет»: регистр и пунктуация роли не играют. */
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
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
 * Шаблонный комментарий — подстраховка на единичный сбой сети, не рабочий режим.
 *
 * Раньше вариант выбирался как `list[promptIndex % list.length]`: promptIndex у всех
 * аккаунтов задачи один и тот же, поэтому все они писали ДОСЛОВНО одинаковый текст
 * под одним постом (прогон 21.07, подтверждено скриншотом канала). Для Telegram это
 * очевидная сетка ботов. Теперь вариант выбирается случайно и с оглядкой на уже
 * отправленное в этой задаче.
 *
 * @param {string} postText
 * @param {number} promptIndex
 * @param {Set<string>} [avoid] уже отправленные тексты (нормализованные)
 */
function templateComment(postText, promptIndex, avoid = new Set()) {
  const text = (postText || '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const hook = words.slice(0, 5).join(' ')
  const lower = text.toLowerCase()

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
    ], avoid)
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
  ], avoid, FALLBACKS)
}

/**
 * Случайный вариант из списка, которого ещё не было. Если все уже использованы —
 * берём из запасного списка, и только потом сдаёмся и повторяемся.
 * @param {string[]} list @param {Set<string>} avoid @param {string[]} [spare]
 */
function pickUnused(list, avoid, spare = []) {
  const fresh = [...list, ...spare].filter((v) => !avoid.has(normalizeText(v)))
  const pool = fresh.length ? fresh : list
  return pool[Math.floor(Math.random() * pool.length)]
}
