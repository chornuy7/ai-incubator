/** Тексты системных промптов по умолчанию (индекс = promptIndex на бэкенде). */
export const DEFAULT_PROMPT_BODIES = [
  'Напиши короткий позитивный комментарий к посту. 1-2 предложения, без хештегов.',
  'Напиши тёплый, дружелюбный комментарий. 1-2 предложения, без панибратства.',
  'Напиши эмоциональный отклик на пост. 1-2 предложения.',
  'Задай один уместный вопрос автору по теме поста. Одно предложение.',
  'Напиши краткий отзыв на пост. Одно предложение.',
  'Напиши аналитический комментарий. 1-2 предложения, по делу.',
]

export function loadPromptBodies(moduleKey: string, labels: string[]): string[] {
  try {
    const raw = localStorage.getItem(`ai-incubator:prompts:${moduleKey}`)
    if (raw) {
      const saved = JSON.parse(raw) as string[]
      if (Array.isArray(saved) && saved.length === labels.length) return saved
    }
  } catch { /* ignore */ }
  return labels.map((_, i) => DEFAULT_PROMPT_BODIES[i] ?? DEFAULT_PROMPT_BODIES[0])
}

export function savePromptBodies(moduleKey: string, bodies: string[]) {
  localStorage.setItem(`ai-incubator:prompts:${moduleKey}`, JSON.stringify(bodies))
}
