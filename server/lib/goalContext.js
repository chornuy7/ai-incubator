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
