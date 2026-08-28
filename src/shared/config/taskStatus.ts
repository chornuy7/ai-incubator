/**
 * Единая палитра статусов задачи — ОДИН источник правды для бейджа, кольца прогресса,
 * сегмента пончика и точки в легенде.
 *
 * Зачем файл: цвет статуса жил в двух несогласованных таблицах на странице задач, и один
 * и тот же статус красился по-разному в соседних элементах одной карточки:
 *   • «Выполняется» — бейдж зелёный, кольцо голубое;
 *   • «Готово»      — бейдж серый,   кольцо зелёное.
 * То есть зелёный на дашборде означал одновременно «идёт» и «завершено», а «Готово»
 * читалось как выключенный/неважный статус. Теперь цвет берётся отсюда, и бейдж
 * физически не может разойтись с кольцом — у них общий `base`.
 *
 * Раскладка (по смыслу, а не по красоте):
 *   Выполняется  — голубой  (живое движение)
 *   В очереди    — фиолет   (ждёт своей очереди)
 *   На паузе     — янтарь, зебра (приостановлено, место за задачей сохранено)
 *   Остановлена  — янтарь   (остановлено оператором)
 *   Ошибка       — красный  (провал)
 *   Готово       — зелёный  (успех; зелёный = завершение, и только оно)
 */

export type TaskStatusKey = 'running' | 'queued' | 'paused' | 'stopped' | 'error' | 'done'

export interface TaskStatusTone {
  label: string
  /** Базовый цвет статуса: кольцо, сегмент пончика, точка легенды, фон и рамка бейджа. */
  base: string
  /** Осветлённый оттенок для подписи — базовый цвет на тёмном фоне читается хуже. */
  text: string
  /**
   * Переходное состояние → фон бейджа в диагональную зебру. Так «На паузе» отличается от
   * «Остановлена» (оба янтарные — это одна семья «работа встала»), не занимая шестой цвет:
   * сплошная заливка = состояние устоялось, полоска = задача между состояниями.
   */
  zebra?: boolean
}

export const TASK_STATUS: Record<TaskStatusKey, TaskStatusTone> = {
  running: { label: 'Выполняется', base: '#38bdf8', text: '#7dd3fc' },
  queued: { label: 'В очереди', base: '#7145ff', text: '#b1a8ff' },
  paused: { label: 'На паузе', base: '#f59e0b', text: '#fcd34d', zebra: true },
  stopped: { label: 'Остановлена', base: '#f59e0b', text: '#fcd34d' },
  error: { label: 'Ошибка', base: '#f43f5e', text: '#fda4af' },
  done: { label: 'Готово', base: '#0ec464', text: '#77efab' },
}

/** Порядок статусов в фильтре и в легенде пончика. */
export const TASK_STATUS_KEYS: TaskStatusKey[] = ['running', 'queued', 'stopped', 'error', 'done']

/** Нейтральный тон для неизвестного статуса (бэкенд добавил новый — не падаем). */
export const TASK_STATUS_FALLBACK: TaskStatusTone = { label: '—', base: '#94a3b8', text: '#cbd5e1' }

export function statusTone(status: string): TaskStatusTone {
  return TASK_STATUS[status as TaskStatusKey] ?? { ...TASK_STATUS_FALLBACK, label: status }
}

/** Цвет для SVG (кольцо прогресса, сегмент пончика, точка легенды). */
export function statusColor(status: string): string {
  return statusTone(status).base
}

/**
 * Оптимистичный тон на время действия: воркер встаёт не мгновенно, и до подтверждения
 * показываем «Останавливается…» / «Ставим на паузу…». Зебра здесь по делу — задача
 * буквально между состояниями.
 */
export function pendingTone(action: 'pause' | 'stop'): TaskStatusTone {
  return {
    ...TASK_STATUS.paused,
    label: action === 'stop' ? 'Останавливается…' : 'Ставим на паузу…',
  }
}

/** #rrggbb + доля прозрачности → rgba(). Один цвет статуса даёт и текст, и фон, и рамку. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Фон бейджа: сплошная заливка 12% либо зебра для переходных состояний. Полоски
 * специально низкоконтрастные (18% / 6%) — это фактура, а не второй цвет: тег должен
 * читаться как один статус, а не как две плашки.
 */
/**
 * Заливка ТОЧКИ статуса (легенда чарта, заголовок группы) — кружок 8–10 px.
 *
 * Цвет здесь сплошной, а не подложка, поэтому зебра берётся в полную силу. Шаг — самый
 * мелкий во всей палитре: на восьми пикселях шаг тега (5 px) дал бы одну диагональную
 * границу, то есть кружок «разрезанный пополам», а не полосатый. При 1 px поперёк
 * помещается пять-шесть полос, и точка читается как штриховка даже в заголовке группы.
 */
export function statusDotFill(tone: TaskStatusTone): string {
  if (!tone.zebra) return tone.base
  return `repeating-linear-gradient(45deg, ${tone.base} 0 1px, ${withAlpha(tone.base, 0.28)} 1px 2px)`
}

export function statusFill(tone: TaskStatusTone): string {
  if (!tone.zebra) return withAlpha(tone.base, 0.12)
  return `repeating-linear-gradient(45deg, ${withAlpha(tone.base, 0.18)} 0 5px, ${withAlpha(tone.base, 0.05)} 5px 10px)`
}
