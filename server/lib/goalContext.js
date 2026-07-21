/**
 * Контекст цели + базы знаний для AI-генерации (§3.6, §4 «AI работает к цели»).
 * Возвращает добавку к системному промпту: описание цели + факты из базы знаний.
 * Ошибки/отсутствие цели → пустая строка (генерация работает как раньше).
 */
import { getGoal } from '../goals.js'
import { listKb } from '../knowledgeBase.js'

/** @param {string|null|undefined} goalId @returns {Promise<string>} */
export async function buildGoalContext(goalId) {
  if (!goalId) return ''
  try {
    const goal = await getGoal(goalId)
    if (!goal) return ''
    const lines = ['', '--- Кампания ведётся к цели ---', `Цель: ${goal.name}`]
    if (goal.targetAction) lines.push(`Целевое действие: ${goal.targetAction}`)
    if (Array.isArray(goal.stages) && goal.stages.length) lines.push(`Этапы: ${goal.stages.join(' → ')}`)
    if (goal.completionCriteria) lines.push(`Критерий завершения: ${goal.completionCriteria}`)
    if (goal.audience) lines.push(`Аудитория: ${goal.audience}`)

    const kb = await listKb(goalId)
    if (kb.length) {
      lines.push('База знаний о продукте (опирайся на эти факты, не выдумывай):')
      for (const k of kb.slice(0, 20)) lines.push(`- ${k.title ? k.title + ': ' : ''}${k.content}`)
    }
    lines.push('Веди себя естественно и ненавязчиво двигай разговор к этой цели. Не спамь.')
    return '\n' + lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * §9: варианты ПЕРВОГО сообщения, заданные в описании цели.
 *
 * Люди пишут их прямо в «Описание» блоками «Первое сообщение:» и «Альтернативное
 * первое сообщение:». Раньше эти заготовки никак не использовались: текст рассылки
 * приходилось дублировать в модуле, и он расходился с целью.
 *
 * @param {object|null} goal
 * @returns {string[]} варианты в порядке появления (пустой массив, если их нет)
 */
export function firstMessagesFromGoal(goal) {
  const text = String(goal?.description || '')
  if (!text.trim()) return []
  const out = []
  // Заголовок вида «Первое сообщение:» / «Альтернативное первое сообщение:» —
  // берём всё до следующего такого заголовка или до конца.
  const re = /(?:^|\n)\s*(?:альтернативн\w*\s+)?первое\s+сообщение\s*:?\s*\n?/gi
  const parts = text.split(re)
  // parts[0] — то, что до первого заголовка (само описание), его пропускаем.
  for (const chunk of parts.slice(1)) {
    const body = chunk.split(/\n\s*\n/)[0].trim()
    if (body) out.push(body)
  }
  return out
}

/** Выбрать вариант первого сообщения по кругу — чтобы все получатели не читали одно и то же. */
export function pickFirstMessage(variants, index = 0) {
  if (!Array.isArray(variants) || !variants.length) return ''
  return variants[Math.abs(Math.floor(index)) % variants.length]
}
