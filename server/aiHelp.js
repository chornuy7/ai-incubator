// AI-помощник Help Center: отвечает на вопросы по разделу с учётом документации модуля.
// Использует OpenAI при наличии OPENAI_API_KEY, иначе — осмысленный fallback по фактам системы.

const GENERAL_FACTS = `Общие правила системы (для точных ответов про тайминги/безопасность):
- Уровни защиты множат все задержки: Консервативный ×1.8, Сбалансированный ×1, Агрессивный ×0.75.
- Пресеты задержек множат сверху: Мин ×0.6, Рекомендуемые ×1, Макс ×1.8.
- При включённой ИИ-защите вероятность действия ограничивается: Консервативный ≤25%, Сбалансированный ≤45%.
- Один аккаунт = одна задача на всех модулях (глобальные локи); занятый профиль помечается «в работе».
- FloodWait: пауза = длительность флуда + запас (по умолчанию 120с); после 3 FloodWait подряд аккаунт уходит в карантин.
- Без ключа OPENAI_API_KEY генерация текста (комментарии/ответы) работает по шаблонам.`

/**
 * @param {{ topic?: string, context?: string, question: string, history?: {role:string,text:string}[] }} p
 * @returns {Promise<{ answer: string, mode: 'openai'|'template_error'|'template_no_key' }>}
 */
export async function answerHelp({ topic, context, question, history }) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const q = String(question || '').trim()
  if (!q) return { answer: 'Задайте вопрос по настройкам раздела.', mode: apiKey ? 'template_error' : 'template_no_key' }

  const system =
    `Ты — встроенный помощник панели управления Telegram-аккаунтами (AI Incubator / GramGPT). ` +
    `Отвечай кратко и по делу, на русском, только про настройки, тайминги, лимиты, безопасность аккаунтов и работу модулей. ` +
    `Опирайся на документацию раздела ниже. Если ответа в ней нет — честно скажи и предложи, что уточнить. Не выдумывай функций, которых нет.` +
    `\n\nРаздел: ${topic || '—'}` +
    (context ? `\n\nДокументация раздела:\n${String(context).slice(0, 3000)}` : '') +
    `\n\n${GENERAL_FACTS}`

  if (apiKey) {
    try {
      const messages = [{ role: 'system', content: system }]
      for (const m of (history || []).slice(-6)) {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 1200) })
      }
      messages.push({ role: 'user', content: q })
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages,
          max_tokens: 400,
          temperature: 0.4,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const text = data?.choices?.[0]?.message?.content?.trim()
        if (text && text.length >= 2) return { answer: text, mode: 'openai' }
      } else {
        console.warn('[aiHelp] OpenAI HTTP', res.status, (await res.text().catch(() => '')).slice(0, 200))
      }
    } catch (err) {
      console.warn('[aiHelp] OpenAI error:', err instanceof Error ? err.message : err)
    }
  }

  return { answer: fallbackAnswer(topic, q, context), mode: apiKey ? 'template_error' : 'template_no_key' }
}

/** Осмысленный ответ без OpenAI: подбираем релевантные факты по ключевым словам вопроса. */
function fallbackAnswer(topic, question, context) {
  const ql = question.toLowerCase()
  const t = (topic || 'раздел').trim()
  const parts = []

  if (/(задержк|пауз|скорост|flood|флуд|быстр|медлен)/.test(ql)) {
    parts.push('Задержки — это паузы между действиями и вступлением в цель. Их множат уровень защиты (Консервативный ×1.8 / Сбалансированный ×1 / Агрессивный ×0.75) и пресет (Мин ×0.6 / Рекомендуемые ×1 / Макс ×1.8). Начните с «Рекомендуемые» и подбирайте под нужный баланс скорость/риск. FloodWait ставит паузу на длительность флуда + запас (~120с); после 3 подряд — карантин.')
  }
  if (/(защит|безопас|бан|карантин|риск|spam|спам)/.test(ql)) {
    parts.push('ИИ-защита снижает риск: ограничивает вероятность действия (Консервативный ≤25%, Сбалансированный ≤45%), увеличивает задержки и уводит аккаунт в карантин после серии FloodWait. Аккаунты со статусами quarantine/spamblock/frozen/reauth пропускаются.')
  }
  if (/(аккаунт|акк|busy|в работе|лок|lock|занят|параллел)/.test(ql)) {
    parts.push('Один аккаунт = одна задача на всех модулях (глобальный лок). Пока идёт задача, профиль «в работе» и недоступен другим модулям; после завершения лок снимается автоматически.')
  }
  if (/(лимит|количеств|сколько|макс|limit)/.test(ql)) {
    parts.push('Лимиты ограничивают общий объём действий и объём на один аккаунт; в режиме «По времени» вместо количества задаётся длительность. Для парсеров лимит ограничивает число результатов/участников на цель.')
  }
  if (/(openai|ии|нейросет|ключ|api|шаблон|comment|коммент)/.test(ql)) {
    parts.push('Генерация текста (комментарии/ответы/этот помощник) использует OpenAI при заданном OPENAI_API_KEY в .env. Без ключа всё работает, но текст — по шаблонам; в логах это помечается «Шаблон».')
  }

  if (!parts.length) {
    const hint = context ? `Кратко по разделу «${t}»: ${String(context).slice(0, 260)}…` : `Раздел «${t}».`
    parts.push(`${hint}\n\nСформулируйте вопрос про задержки, лимиты, безопасность аккаунтов или конкретную настройку — отвечу точнее. Для развёрнутых ИИ-ответов добавьте OPENAI_API_KEY в .env.`)
  } else {
    parts.push(`(Ответ по фактам системы для раздела «${t}». Для развёрнутых ИИ-ответов добавьте OPENAI_API_KEY в .env.)`)
  }
  return parts.join('\n\n')
}
