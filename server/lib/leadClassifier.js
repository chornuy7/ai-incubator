/**
 * §9: ИИ-классификатор ответа лида → статус воронки CRM.
 *
 * Простой вариант «верим на слово»: статус ставится по ТЕКСТУ ответа, без проверки
 * фактического действия (подписался ли человек на самом деле). Проверку админским
 * аккаунтом/инвайт-ссылками добавим отдельно — тогда `target` будет подтверждаться.
 *
 * Двигаем воронку только ВПЕРЁД (это гарантирует upsertLead в leads.js), кроме отказа:
 * явный отказ переводит в `closed` в любой момент.
 */
import { LEAD_STATUSES } from '../leads.js'

/** Порядок воронки (без терминальных target/closed). */
const FUNNEL = ['cold', 'contacted', 'warm', 'interested', 'hot']

// NB: без \b — в JS это ASCII-граница слова, с кириллицей она не срабатывает.
/** Явный отказ — уводим в closed, дальше не пишем. */
const REFUSE = /(не интересн|не надо|отстань|отвали|не пиши|отпишись|спам|нет,? спасибо|уберите меня|блокир)/i
/** Целевое действие подтверждено словами: «подписался», «сделал», «готово». */
const DONE = /(подписал|вступил|присоединил|подписка оформлена|сделал|готово|выполнил|уже там|зашёл|зашел|перешёл|перешел)/i
/** Горячий: просит ссылку / как вступить / готов прямо сейчас. */
const HOT = /(давай ссылк|скинь ссылк|дай ссылк|как вступить|как подписат|где подписат|куда переход|готов|хочу|покупа|оплат|беру)/i
/** Заинтересован: спрашивает подробности. */
const INTERESTED = /(расскажи|подробн|что это|интересно|а что|сколько стоит|цена|какие услов|а как)/i
/** Односложный ответ без интереса — «ок», «ага», «угу». */
const SHORT = /^(ок|окей|ok|ага|угу|да|нет|хм|ясно|понятно|\+|спасибо|спс)[.!)\s]*$/i

/**
 * Классификация по правилам — фолбэк без OpenAI и страховка поверх ИИ.
 * @param {string} text ответ лида
 * @returns {{ status: string, reason: string } | null}
 */
export function classifyByRules(text) {
  const t = String(text || '').trim()
  if (!t) return null
  if (REFUSE.test(t)) return { status: 'closed', reason: 'явный отказ' }
  if (DONE.test(t)) return { status: 'target', reason: 'подтвердил целевое действие словами' }
  if (HOT.test(t)) return { status: 'hot', reason: 'просит ссылку / готов действовать' }
  if (INTERESTED.test(t)) return { status: 'interested', reason: 'спрашивает подробности' }
  if (SHORT.test(t)) return { status: 'contacted', reason: 'односложный ответ' }
  return { status: 'warm', reason: 'ответил по делу' }
}

/** Индекс в воронке; терминальные — отдельно. @param {string} s */
function rank(s) {
  const i = FUNNEL.indexOf(s)
  return i === -1 ? -1 : i
}

/**
 * Классифицировать ответ лида и вернуть новый статус.
 * ИИ (если есть ключ) даёт основной вердикт, правила — фолбэк и защита от бреда модели.
 *
 * @param {{ text: string, currentStatus?: string, goalName?: string, targetAction?: string }} input
 * @returns {Promise<{ status: string, reason: string, mode: 'openai'|'rules' }>}
 */
export async function classifyLeadReply({ text, currentStatus = 'cold', goalName = '', targetAction = '' }) {
  const fallback = classifyByRules(text) || { status: currentStatus, reason: 'пустой ответ' }
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey || !String(text || '').trim()) {
    return { ...fallback, mode: 'rules' }
  }

  const system = [
    'Ты классифицируешь ответ человека в переписке и определяешь стадию воронки продаж.',
    goalName ? `Цель кампании: ${goalName}.` : '',
    targetAction ? `Целевое действие, которого мы добиваемся: ${targetAction}.` : '',
    'Верни СТРОГО один из статусов без пояснений:',
    'closed — явный отказ, просит не писать;',
    'target — подтвердил, что выполнил целевое действие (подписался/сделал);',
    'hot — готов действовать прямо сейчас, просит ссылку;',
    'interested — задаёт уточняющие вопросы, интересуется;',
    'warm — ответил нейтрально, диалог идёт;',
    'contacted — ответил односложно, без интереса.',
  ].filter(Boolean).join('\n')

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Ответ человека:\n${String(text).slice(0, 600)}` },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z]/g, '')
      if (LEAD_STATUSES.includes(raw)) {
        // Страховка: правила увидели явный отказ/выполнение — доверяем им больше,
        // чем модели (дешевле ошибиться в сторону «не спамить дальше»).
        if (fallback.status === 'closed') return { ...fallback, mode: 'rules' }
        return { status: raw, reason: 'ИИ-классификация ответа', mode: 'openai' }
      }
    }
  } catch (err) {
    console.warn('[leadClassifier] OpenAI error:', err instanceof Error ? err.message : err)
  }
  return { ...fallback, mode: 'rules' }
}

/**
 * Нужно ли обновлять статус: вперёд по воронке либо в терминальный.
 * @param {string} current @param {string} next
 */
export function shouldAdvance(current, next) {
  if (!next || next === current) return false
  if (next === 'closed' || next === 'target') return true
  if (current === 'closed' || current === 'target') return false // терминальные не откатываем
  return rank(next) > rank(current)
}
