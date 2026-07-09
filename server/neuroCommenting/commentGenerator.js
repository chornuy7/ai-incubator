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

/** @param {string} postText @param {number} promptIndex @param {string} [systemPrompt] */
export async function generateComment(postText, promptIndex = 0, systemPrompt) {
  const snippet = (postText || '').slice(0, 500)
  const system = systemPrompt?.trim() || PROMPTS[promptIndex] || PROMPTS[0]
  const apiKey = process.env.OPENAI_API_KEY?.trim()

  if (apiKey) {
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
          temperature: 0.85,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const text = data?.choices?.[0]?.message?.content?.trim()
        if (text && text.length >= 3 && text.length <= 400) {
          return { text, mode: 'openai' }
        }
      } else {
        const errBody = await res.text().catch(() => '')
        console.warn('[generateComment] OpenAI HTTP', res.status, errBody.slice(0, 200))
      }
    } catch (err) {
      console.warn('[generateComment] OpenAI error:', err instanceof Error ? err.message : err)
    }
  }

  return { text: templateComment(snippet, promptIndex), mode: apiKey ? 'template_api_error' : 'template_no_key' }
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

/** @param {string} postText @param {number} promptIndex */
function templateComment(postText, promptIndex) {
  const text = (postText || '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const hook = words.slice(0, 5).join(' ')
  const lower = text.toLowerCase()

  const isGreeting = !text
    || words.length <= 3
    || /^(welcome|привет|hello|hi|добр|здравств)/i.test(lower)

  if (isGreeting) {
    const greet = [
      'Привет! Рад быть здесь, буду следить за обновлениями.',
      'Добрый день! Спасибо, что добавили в чат.',
      'Круто, что чат живёт — интересно, что дальше будет.',
      'Приветствую! Есть планы по ближайшим апдейтам?',
      'Здорово познакомиться с проектом, спасибо за welcome.',
      'Привет! Выглядит перспективно, буду на связи.',
    ]
    return greet[promptIndex % greet.length]
  }

  if (promptIndex === 3) return `А что думаете про «${hook.toLowerCase()}»?`
  if (promptIndex === 5) return `По теме «${hook}» — логично и по существу.`

  const contextual = [
    `По «${hook}» — согласен, хорошая мысль.`,
    `Насчёт «${hook}» — приятно читать, спасибо.`,
    `Про «${hook}» — полезно, возьму на заметку.`,
    `«${hook}» — актуально, спасибо что поделились.`,
    `«${hook}» — коротко и по делу, понравилось.`,
    `По «${hook}» — интересный угол, жду продолжения.`,
  ]
  return contextual[promptIndex % contextual.length] || FALLBACKS[promptIndex % FALLBACKS.length]
}
