import { apiGet, apiPost, apiPut, apiDelete } from './client'

/**
 * Агент (AI-персона) — «как общаться», отдельно от Цели («что достичь»).
 * Решение созвона 22.07. Выбирается в задаче кампании, как выбирается цель.
 */
export interface AgentFollowUp {
  enabled: boolean
  limit: number
  instructions: string
}

export interface Agent {
  id: string
  name: string
  /** Тон общения — как писать. */
  toneOfVoice: string
  /** Ограничения — чего писать нельзя. */
  restrictions: string
  /** Характер/роль свободным текстом: «дружелюбный эксперт», «скептик-спорщик». */
  character: string
  /** Язык общения; пусто — язык собеседника. */
  language: string
  /** С кем говорим — портрет собеседника. Переехало из цели (24.07). */
  audience: string
  /** Когда разговор доведён до конца. Переехало из цели (24.07). */
  completionCriteria: string
  /** Заготовки первого сообщения (мейлинг): варианты через пустую строку, чередуются по кругу. */
  firstMessage: string
  createdAt: number
  updatedAt: number
}

export interface AgentInput {
  name: string
  toneOfVoice?: string
  restrictions?: string
  character?: string
  language?: string
  audience?: string
  completionCriteria?: string
  firstMessage?: string
}

export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

export async function fetchAgents(): Promise<Agent[]> {
  const data = await apiGet<{ agents: Agent[] }>('/api/agents')
  return data.agents
}

export async function createAgent(input: AgentInput): Promise<Agent> {
  const data = await apiPost<{ agent: Agent }>('/api/agents', input)
  return data.agent
}

export async function updateAgent(id: string, patch: Partial<AgentInput>): Promise<Agent> {
  const data = await apiPut<{ agent: Agent }>(`/api/agents/${id}`, patch)
  return data.agent
}

export async function deleteAgent(id: string): Promise<void> {
  await apiDelete(`/api/agents/${id}`)
}

/* ── База знаний агента (переезд из цели, 24.07) ──
   Факты о продукте, на которые персона опирается в разговоре. Это часть ведения
   диалога, а не измеримого результата, поэтому живёт у агента. Тип записи общий
   с прежним хранилищем: поле `goalId` там означает «к чему привязана запись» —
   для агента туда кладётся его id (идентификаторы не пересекаются). */
export interface AgentKbItem {
  id: string
  goalId: string
  kind: 'text' | 'file' | 'image' | 'link'
  /** Исходная ссылка — чтобы страницу можно было открыть и перечитать. */
  url?: string | null
  title: string
  content: string
  fileRef: string | null
  createdAt: number
}

export async function fetchAgentKb(agentId: string): Promise<AgentKbItem[]> {
  const data = await apiGet<{ ok: boolean; items: AgentKbItem[] }>(`/api/agents/${agentId}/kb`)
  return data.items
}

export async function createAgentKb(agentId: string, input: { title?: string; content: string }): Promise<AgentKbItem> {
  const data = await apiPost<{ ok: boolean; item: AgentKbItem }>(`/api/agents/${agentId}/kb`, input)
  return data.item
}

export async function deleteAgentKb(agentId: string, kbId: string): Promise<void> {
  await apiDelete(`/api/agents/${agentId}/kb/${kbId}`)
}

/** Потолок файла базы знаний — зеркало server/kbFiles.js. Проверяем ДО отправки. */
export const KB_FILE_MAX_BYTES = 3 * 1024 * 1024

/** Загрузить один файл в базу знаний агента (data-URL). Пачку шлём по одному — так виден прогресс. */
export async function uploadAgentKbFile(agentId: string, file: File): Promise<AgentKbItem> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Не удалось прочитать файл'))
    r.readAsDataURL(file)
  })
  const data = await apiPost<{ ok: boolean; item: AgentKbItem }>(
    `/api/agents/${agentId}/kb/upload`, { name: file.name, dataUrl },
  )
  return data.item
}

/**
 * Добавить страницы/ссылки ПАЧКОЙ. Сервер сам скачивает текст: модель по ссылке
 * не ходит, и голый URL в промпте бесполезен.
 */
export async function addAgentKbLinks(agentId: string, urls: string[]): Promise<{
  added: AgentKbItem[]
  failed: { url: string; reason: string }[]
}> {
  return apiPost(`/api/agents/${agentId}/kb/links`, { urls })
}

/** Ссылка на файл базы знаний (превью/скачивание). */
export function agentKbFileUrl(fileRef: string): string {
  return `/api/goals/kb-file/${fileRef}`
}
