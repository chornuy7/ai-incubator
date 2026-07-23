import { apiGet, apiPost, apiDelete, parseJson } from './client'

export interface Goal {
  id: string
  name: string
  description: string
  targetAction: string
  stages: string[]
  completionCriteria: string
  audience: string
  channels: string[]
  deadline: string | null // §4: дедлайн (ISO-дата) или null
  leadTarget: number // §4: сколько лидов должна привести цель (0 = не задано)
  // SPEC §1.2 (звонок 22.07): тон, ограничения и дожим переехали в сущность «Агент».
  // У целей, созданных раньше, поля ещё лежат в данных — держим опциональными, чтобы
  // старые записи не ломали типы, но в форме и в промпте они больше не участвуют.
  followUp?: FollowUp
  toneOfVoice?: string
  restrictions?: string
  createdAt: number
  updatedAt: number
}

export interface GoalInput {
  name: string
  description?: string
  targetAction?: string
  stages?: string[]
  completionCriteria?: string
  audience?: string
  channels?: string[]
  deadline?: string | null
  leadTarget?: number
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

/** §4: истёк ли дедлайн цели (зеркало server/goals.js#isGoalExpired). Дедлайн включает весь день. */
export function isGoalExpired(goal: Pick<Goal, 'deadline'>, now = Date.now()): boolean {
  if (!goal.deadline) return false
  const d = new Date(goal.deadline)
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
  const res = await fetch(`/api/goals/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseJson<{ ok: boolean; goal: Goal }>(res)
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
