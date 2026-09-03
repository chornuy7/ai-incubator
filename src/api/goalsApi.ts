import { apiGet, apiPost, apiDelete, apiPut } from './client'

/** Что именно считаем. Виды — те результаты, которые система умеет посчитать сама. */
export type MetricKind = 'leads' | 'clicks' | 'joins' | 'replies' | 'custom'

export const METRIC_LABELS: Record<MetricKind, string> = {
  leads: 'горячих лидов',
  clicks: 'переходов по ссылке',
  joins: 'вступлений',
  replies: 'ответов',
  custom: 'шт.',
}

/** Измеримый результат: что считаем и сколько нужно набрать. */
export interface GoalMetric {
  kind: MetricKind
  /** Сколько единиц нужно (0 = не задано). */
  target: number
  /** Единица словами — для карточки и отчёта кампании. */
  unit: string
}

/** Жизненный цикл цели — зеркало server/goals.js. */
export type GoalStatus = 'active' | 'achieved' | 'archived'
export const GOAL_STATUSES: GoalStatus[] = ['active', 'achieved', 'archived']
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: 'Активна', achieved: 'Достигнута', archived: 'В архиве',
}

/** Приоритет цели — зеркало server/goals.js. */
export type GoalPriority = 'low' | 'mid' | 'high'
export const GOAL_PRIORITIES: GoalPriority[] = ['low', 'mid', 'high']
export const GOAL_PRIORITY_LABELS: Record<GoalPriority, string> = {
  low: 'Низкий', mid: 'Средний', high: 'Высокий',
}

/** Период учёта счётчика: за всё время или с даты. */
export interface GoalPeriod {
  mode: 'all' | 'from'
  /** 'YYYY-MM-DD', когда mode === 'from'; иначе null. */
  from: string | null
}

/**
 * Цель — это СЧЁТЧИК: что нужно получить и сколько. Больше в ней ничего нет.
 *
 * Решения звонков 22.07 и 24.07:
 *   тон, запреты, характер, язык, аудитория, критерий завершения → АГЕНТ
 *   дожим, дедлайн, каналы, модули                               → КАМПАНИЯ
 * У целей, созданных раньше, лишние поля ещё лежат в данных — они просто
 * перестают участвовать; отдельная миграция не нужна.
 */
export interface Goal {
  id: string
  name: string
  /**
   * Свободный текст желания. Из формы убран (цель не «руководит» ИИ) — остаётся в данных
   * старых целей для совместимости, пока мейлинг не берёт первое сообщение из Агента.
   */
  description: string
  metric: GoalMetric
  status: GoalStatus
  priority: GoalPriority
  period: GoalPeriod
  createdAt: number
  updatedAt: number
}

export interface GoalInput {
  name: string
  description?: string
  metric?: Partial<GoalMetric>
  status?: GoalStatus
  priority?: GoalPriority
  period?: GoalPeriod
}

/**
 * §9 «дожим»: что делать, когда по человеку цель уже закрыта (достигнута или он
 * отказался), а он написал снова. Молчать — терять самый тёплый контакт, какой
 * бывает: написал он сам. Лимит держит дожим в рамках ответа, а не новой рассылки.
 */
export interface FollowUp {
  enabled: boolean
  /** Сколько сообщений подряд можно дожимать одного человека. */
  limit: number
  /** Свободные указания ИИ на время дожима (необязательно). */
  instructions: string
}

/** Зеркало server/goals.js. */
export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

/** §4: границы дедлайна — зеркало server/goals.js. Прошлое разрешено (по нему проверяют «просрочено»). */
export const DEADLINE_MIN_YEAR = 2000
export const DEADLINE_MAX_YEAR = new Date().getFullYear() + 20
/** §4: потолок цели по лидам — зеркало server/goals.js. Больше — это опечатка, а не план. */
export const LEAD_TARGET_MAX = 1_000_000

/**
 * §4: дата в разумных пределах и реально существует. Нужна форме, чтобы показать
 * ошибку сразу, а не после отказа сервера. Раньше проходил год 123123.
 */
export function isSaneDeadline(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim())
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < DEADLINE_MIN_YEAR || y > DEADLINE_MAX_YEAR) return false
  const dt = new Date(`${v}T00:00:00Z`)
  return !isNaN(dt.getTime()) && dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d
}

/**
 * Истёк ли дедлайн (зеркало server/goals.js#isGoalExpired). Дедлайн включает весь день.
 * Дедлайн переехал из цели в КАМПАНИЮ (24.07) — функция осталась общей, ей всё равно,
 * чей объект пришёл: важно только поле `deadline`.
 */
export function isGoalExpired(owner: { deadline?: string | null }, now = Date.now()): boolean {
  if (!owner.deadline) return false
  const d = new Date(owner.deadline)
  if (isNaN(d.getTime())) return false
  return now > d.getTime() + 24 * 60 * 60 * 1000 - 1
}

export async function fetchGoals(): Promise<Goal[]> {
  const data = await apiGet<{ ok: boolean; goals: Goal[] }>('/api/goals')
  return data.goals
}

export async function createGoal(input: GoalInput): Promise<Goal> {
  const data = await apiPost<{ ok: boolean; goal: Goal }>('/api/goals', input)
  return data.goal
}

export async function updateGoal(id: string, patch: Partial<GoalInput>): Promise<Goal> {
  const data = await apiPut<{ ok: boolean; goal: Goal }>(`/api/goals/${id}`, patch)
  return data.goal
}

export async function deleteGoal(id: string): Promise<void> {
  await apiDelete(`/api/goals/${id}`)
}

// ── База знаний цели (§3.6) ──
export interface KbItem {
  id: string
  goalId: string
  kind: 'text' | 'file' | 'image'
  title: string
  content: string
  fileRef: string | null
  scope: string
  version: number
  createdAt: number
  updatedAt: number
}

export async function fetchKb(goalId: string): Promise<KbItem[]> {
  const data = await apiGet<{ ok: boolean; items: KbItem[] }>(`/api/goals/${goalId}/kb`)
  return data.items
}

export async function createKb(goalId: string, input: { title?: string; content: string }): Promise<KbItem> {
  const data = await apiPost<{ ok: boolean; item: KbItem }>(`/api/goals/${goalId}/kb`, input)
  return data.item
}

export async function deleteKb(goalId: string, kbId: string): Promise<void> {
  await apiDelete(`/api/goals/${goalId}/kb/${kbId}`)
}

/**
 * §4: потолок размера файла базы знаний. Должен совпадать с `KB_FILE_MAX_BYTES`
 * в server/kbFiles.js — фронт проверяет его ПЕРВЫМ, до отправки, потому что файл
 * уходит data-URL'ом и base64 раздувает его на треть, пробивая лимит тела запроса
 * express раньше серверной проверки (тест 5.6).
 */
export const KB_FILE_MAX_BYTES = 3 * 1024 * 1024

/** §4: загрузить файл в базу знаний цели (data-URL, до 3 МБ). */
export async function uploadKbFile(goalId: string, file: File, title?: string): Promise<KbItem> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Не удалось прочитать файл'))
    r.readAsDataURL(file)
  })
  const data = await apiPost<{ ok: boolean; item: KbItem }>(`/api/goals/${goalId}/kb/upload`, { name: file.name, dataUrl, title })
  return data.item
}

/** §4: ссылка на файл базы знаний (превью/скачивание). */
export function kbFileUrl(fileRef: string): string {
  return `/api/goals/kb-file/${fileRef}`
}

/**
 * Счётчик цели: сколько набрано против плана. Считает сервер — тот же счёт читает
 * статистика кампаний, поэтому в карточке он не пересчитывается заново.
 */
export interface GoalProgress {
  kind: MetricKind
  target: number
  unit: string
  done: number
  pct: number
  /** Умеет ли система считать этот вид сама. false — показываем только план. */
  counted: boolean
  /** Скольких довели ДОЖИМОМ — тех, кто написал сам после закрытия диалога. */
  followUpsDone: number
}

export async function fetchGoalProgress(): Promise<Record<string, GoalProgress>> {
  const data = await apiGet<{ ok: boolean; progress: Record<string, GoalProgress> }>('/api/goals/progress')
  return data.progress
}
