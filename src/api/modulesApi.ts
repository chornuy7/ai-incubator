import type { LogEntry } from '@/shared/types'
import { apiGet, apiPost, apiDelete, apiPatch } from './client'

export interface ModuleTaskSettings {
  accountIds: string[]
  targets?: string[]
  channels?: string[]
  keywords?: string[]
  commentMode?: number
  stopWords?: string[] // §3.5: пропускать посты с этими словами (фильтр тональности/тем)
  workMode?: number
  postFilter?: number
  probability?: number
  maxActions?: number
  maxComments?: number
  maxPerAccount?: number
  // ── (4) Минимумы: воркер выбирает цель в диапазоне [min, max] ──
  minActions?: number
  minPerAccount?: number
  minWords?: number
  durationMinutes?: number
  aiProtection?: boolean
  protectionLevel?: number
  /** MR-134: уведомлять о статусе ЭТОЙ задачи (ошибка/пауза) в колокольчике. По умолчанию — да. */
  notifyOnStatus?: boolean
  promptIndex?: number
  promptText?: string
  promptOverrides?: string[]
  mediaUrls?: string[] // §11: медиа (фото/видео/ссылки) для мейлинга/автопостинга
  campaignId?: string // §0: задача идёт под кампанией (цель наследуется от неё)
  aiMode?: number
  delayPreset?: number
  emojis?: string[]
  postUrls?: string[]
  limit?: number
  // ── Парсер каналов/групп ──
  searchMode?: number // 0 = по ключевым словам, 1 = похожие каналы
  endings?: string[]
  minMembers?: number
  maxMembers?: number
  resultLimit?: number // 0 = без лимита
  activityFilter?: number // 0 любая / 1 активные / 2 неактивные
  /** §3.8: минимальный балл канала. Считает сервер по живым сигналам — постам, свежести, отклику (26.08). */
  minRating?: number
  commentFilter?: number // 0 любые / 1 открытые / 2 закрытые
  minComments?: number
  langDetection?: boolean
  alreadyParsed?: string[]
  intersect?: boolean // §3.8: AND-пересечение — канал должен совпасть со ВСЕМИ ключевыми словами
  // ── Парсер участников (users/messages/comments) ──
  filters?: Record<string, boolean>
  limits?: Record<string, number>
  activeStories?: boolean
  intersectionMode?: boolean
  intersectionMin?: number
  // userSource убран: собираем и список участников, и писавших сразу — по отдельности
  // каждый способ терял часть людей (закрытые списки / только активные).
  /** §3.9: аккаунты работают параллельно ВНУТРИ одной задачи, стартуя вразнобой. */
  parallelAccounts?: boolean
  /** §3.9: сколько потоков крутить внутри задачи (1 = последовательно). */
  threads?: number
  delayChat?: number
  delayItem?: number
  // ── Прогрев: уровень (0=2д, 1=3–7д, 2=7–14д) ──
  warmLevel?: number
  // ── Нейрокомментинг: окно последних постов (§3.5) ──
  postWindow?: number
  semanticFilter?: boolean // §3.5: комментировать только по семантически близким к цели постам
  semanticThreshold?: number
  // ── Распределение типов комментариев в % (§3.5), сумма ≈ 100 ──
  typeWeights?: number[]
  // ── Цель кампании (§3.6) ──
  goalId?: string
  // ── НейроДиалоги ──
  replyScope?: 'unread' | 'all' // 'unread' — только новые ЛС, 'all' — все, где последнее слово за собеседником
  dialogGoal?: string // инструкция для ИИ: как себя вести и к чему вести диалог
  analyzeImages?: boolean // §10.5: описывать входящие фото vision-моделью (расход ×imageMultiplier)
  /** §9: сколько сообщений пишем ОДНОМУ лиду — до целевого действия или фиксированным числом. */
  replyLimitMode?: 'untilTarget' | 'count'
  /** §9: лимит ответов на лида при replyLimitMode='count' (0 = без лимита). */
  maxRepliesPerLead?: number
  maxActiveDialogs?: number // §3.6: лимит активных диалогов на аккаунт (0 = без лимита)
  // ── Масслукинг: что смотреть и сколько последних постов ──
  lookMode?: 'stories' | 'posts' | 'both'
  lookPostsCount?: number
  /** Массовые реакции: 0 — мониторинг новых постов, 1 — N последних постов. */
  reactMode?: number
  /** Сколько последних постов канала рассматривать (реакции и нейрокомментинг). */
  lastPostsCount?: number
  /** Брать один случайный пост из подходящих (иначе — все подходящие за заход). */
  pickOne?: boolean
  delays?: {
    comment?: [number, number]
    action?: [number, number]
    dm?: [number, number]
    join?: [number, number]
    request?: [number, number]
    channel?: [number, number]
    floodWait?: number
    floodQuarantine?: number
  }
  aiPerRecipient?: boolean
}

export interface ModuleTaskProgress {
  done: number
  total: number
  actionsDone?: number
  commentsSent?: number
  /**
   * Сколько задача ФАКТИЧЕСКИ простояла в паузах (мс). В отличие от ETA — это не прогноз,
   * а накопленная сумма: задержки между действиями, «чтение и набор», ожидание отдыха.
   * Нужна, чтобы «за час пять комментариев» объяснялось цифрой, а не догадками (20.08).
   */
  waitMs?: number
}

export interface ModuleTask {
  id: string
  moduleKey: string
  status: 'queued' | 'running' | 'stopped' | 'done' | 'error' | 'paused'
  initiator?: string | null
  goalId?: string | null
  campaignId?: string | null // §0: под какой кампанией идёт задача
  /** §5.1: монеты за ДЕЙСТВИЯ этого запуска (парсинг/комменты/ЛС). Без токенов ИИ — те в tokenCoins. */
  spentCoins?: number
  /** Токенов ИИ по этой задаче (только в ответе одной задачи, не в списке). */
  tokens?: number
  tokenCalls?: number
  /** §10.1: монеты, списанные за токены ИИ по этой задаче. Полная цена = spentCoins + tokenCoins. */
  tokenCoins?: number
  createdAt: number
  updatedAt: number
  /** MR-134: счётчик ошибок в логах задачи + текст последней — для уведомлений «идёт с ошибками». */
  errors?: number
  lastError?: string
  /** Причина, по которой задача УПАЛА (не просто последняя строка с ошибкой). */
  fatalError?: string
  /** MR-134: пауза именно из-за нулевого баланса (её чинит пополнение), а не рукой. */
  pausedByCoins?: boolean
  /** MR-134: сумма FloodWait по аккаунтам задачи — «упираемся в лимиты Telegram». */
  floodWaits?: number
  progress: ModuleTaskProgress
  settings: ModuleTaskSettings
  logs: LogEntry[]
  history?: Record<string, unknown>[]
  commentHistory?: Record<string, unknown>[]
  results?: Record<string, unknown>[]
  accountStats?: Record<string, { actions?: number; comments?: number; floodWaits: number }>
}

const base = (moduleKey: string) => `/api/modules/${moduleKey}`

/** Аккаунт, который модуль взять не может, и почему. */
export interface BlockedAccount { id: string; status: string; reason: string }

/** Тело ответа 409, когда часть аккаунтов недоступна. */
export interface UnavailablePayload { error: string; blocked?: BlockedAccount[]; usableCount?: number; canSkip?: boolean }

/**
 * @param skipUnavailable исключить недоступные аккаунты и запустить на оставшихся.
 *   Без него сервер отвечает 409 со списком — чтобы спросить человека, а не решать за него.
 */
/**
 * §4.4 (D4): анти-кластерные предупреждения приходят вместе с задачей. Они НЕ
 * блокируют запуск — решение за оператором, — но должны быть видны сразу, а не
 * после того, как Telegram забанит группу волной. Вешаем их на объект задачи,
 * чтобы не менять сигнатуру во всех местах вызова.
 */
export async function startModuleTask(moduleKey: string, settings: ModuleTaskSettings, skipUnavailable = false): Promise<ModuleTask & { clusterWarnings?: string[] }> {
  const data = await apiPost<{ task: ModuleTask; clusterWarnings?: string[] }>(`${base(moduleKey)}/tasks`, { settings, skipUnavailable })
  return { ...data.task, clusterWarnings: data.clusterWarnings || [] }
}

export async function fetchModuleTasks(moduleKey: string): Promise<ModuleTask[]> {
  const data = await apiGet<{ tasks: ModuleTask[] }>(`${base(moduleKey)}/tasks`)
  return data.tasks
}

export async function fetchModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiGet<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}`)
  return data.task
}

export async function stopModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/stop`)
  return data.task
}

export async function restartModuleTask(moduleKey: string, taskId: string, skipUnavailable = false): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/restart`, { skipUnavailable })
  return data.task
}

export async function pauseModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/pause`)
  return data.task
}

/**
 * §9.8: правка настроек задачи. Сервер примет её ТОЛЬКО на паузе (иначе 409):
 * у работающей задачи воркер уже прошёл часть аккаунтов, и правка на лету дала бы
 * результат, где часть отработала по старым настройкам, часть по новым.
 * Состав аккаунтов не меняется — за задачей держатся локи (сервер отбросит поле).
 */
export async function updateModuleTaskSettings(
  moduleKey: string, taskId: string, settings: Partial<ModuleTaskSettings>,
): Promise<ModuleTask> {
  const data = await apiPatch<{ ok: boolean; task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/settings`, { settings })
  return data.task
}

export async function resumeModuleTask(moduleKey: string, taskId: string): Promise<ModuleTask> {
  const data = await apiPost<{ task: ModuleTask }>(`${base(moduleKey)}/tasks/${taskId}/resume`)
  return data.task
}

/** Все задачи по всем модулям (дашборд «Задачи», §3.9). */
export async function fetchAllTasks(): Promise<ModuleTask[]> {
  const data = await apiGet<{ tasks: ModuleTask[] }>('/api/modules/tasks')
  return data.tasks
}

export interface ModulePreset {
  id: string
  name: string
  createdAt: number
  settings: ModuleTaskSettings
  color?: string // §7: цветовая метка шаблона (ключ из PRESET_COLORS)
  owner?: string // §7: владелец персонального шаблона (Маша/Паша)
}

export async function saveModulePreset(moduleKey: string, name: string, settings: ModuleTaskSettings, color?: string, owner?: string) {
  return apiPost(`${base(moduleKey)}/presets`, { name, settings, color, owner })
}

export async function fetchModulePresets(moduleKey: string) {
  const data = await apiGet<{ presets: ModulePreset[] }>(`${base(moduleKey)}/presets`)
  return data.presets
}

export async function deleteModulePreset(moduleKey: string, id: string) {
  const data = await apiDelete<{ presets: Omit<ModulePreset, 'settings'>[] }>(`${base(moduleKey)}/presets/${id}`)
  return data.presets
}

export async function listModuleKeys() {
  const data = await apiGet<{ modules: string[] }>('/api/modules')
  return data.modules
}

/** Legacy neuro-commenting API (backward compat) */
export { startNeuroCommentingTask, fetchNeuroTask, stopNeuroTask } from './neuroCommentingApi'

// ── §9.11: аудитория задачи (кому написали / кто остался) ──

export interface AudienceRow {
  /** Цель в едином виде: «@user» или «+380…». */
  target: string
  /** Контакт, по которому реально писали, — по нему открывается переписка. */
  peer?: string
  accountId?: string
  accountName?: string
  reason?: string
  ts?: string
}

export interface TaskAudience {
  /** Кому написали. */
  sent: AudienceRow[]
  /** Таких нет в Telegram — в следующий заход брать бессмысленно. */
  skipped: AudienceRow[]
  /** Сорвалось из-за аккаунта — этих взять стоит. */
  failed: AudienceRow[]
  /** До них не дошли: остановили, кончились лимиты или аккаунты. */
  remaining: AudienceRow[]
}

export async function fetchTaskAudience(moduleKey: string, id: string): Promise<{ audience: TaskAudience; total: number }> {
  return apiGet<{ audience: TaskAudience; total: number }>(`/api/modules/${moduleKey}/tasks/${id}/audience`)
}

/** §6 (MR-38): сохранённый результат парсинга под совпадающий запрос (кэш-первым). */
export interface ParserCacheHit {
  updatedAt: number
  count: number
  results: Record<string, unknown>[]
}
export async function lookupParserCache(kind: string, settings: Partial<ModuleTaskSettings>): Promise<ParserCacheHit | null> {
  const r = await apiPost<{ ok: boolean; cache: ParserCacheHit | null }>(`/api/parser/cache/lookup`, { kind, settings })
  return r.cache
}

/**
 * Слежение за запросом (просьба владельца 24.08): раз в N часов перезапускать тот же
 * парс, искать новые каналы и отмечать пропавшие. Владельца сервер проставляет сам —
 * перепроверка тратит его аккаунты и его монеты.
 */
export interface ParserWatch {
  sig: string
  kind: string
  label: string
  ownerId: string | null
  periodH: number
  nextRunAt: number
  lastRunAt: number
  lastNew: number
  lastGone: number
  lastError: string | null
  failCount: number
  watch: boolean
  count: number
  updatedAt: number
}
export async function setParserWatch(kind: string, settings: Partial<ModuleTaskSettings>, watch: boolean, periodH = 24): Promise<void> {
  await apiPost(`/api/parser/cache/watch`, { kind, settings, watch, periodH })
}
export async function fetchParserWatches(onlyErrors = false): Promise<ParserWatch[]> {
  const r = await apiGet<{ ok: boolean; watches: ParserWatch[] }>(`/api/parser/watches${onlyErrors ? '?errors=1' : ''}`)
  return r.watches ?? []
}
