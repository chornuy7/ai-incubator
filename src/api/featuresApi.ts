import { apiGet, apiPost, apiPut, apiDelete } from './client'

// ── (6) Глобальный системный промпт ────────────────────────────────────
export interface AiSettings {
  globalSystemPrompt: string
  updatedAt: number
}

export async function fetchAiSettings(): Promise<AiSettings> {
  const data = await apiGet<{ settings: AiSettings }>('/api/ai-settings')
  return data.settings
}

export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const data = await apiPost<{ settings: AiSettings }>('/api/ai-settings', patch)
  return data.settings
}

// ── (11) ИИ-безопасность ────────────────────────────────────────────────
export interface AiSafetySettings {
  onBan: 'continue' | 'quarantine' | 'stop-account' | 'stop-task'
  onSpamblock: 'skip' | 'quarantine'
  floodWaitExtraSeconds: number
  floodQuarantineThreshold: number
  delayMultiplier: number
  pacingMultiplier: number
  perAccountDailyCap: number
  updatedAt: number
}

export async function fetchAiSafety(): Promise<AiSafetySettings> {
  const data = await apiGet<{ settings: AiSafetySettings }>('/api/ai-safety')
  return data.settings
}

export async function saveAiSafety(patch: Partial<AiSafetySettings>): Promise<AiSafetySettings> {
  const data = await apiPost<{ settings: AiSafetySettings }>('/api/ai-safety', patch)
  return data.settings
}

// ── (10) Чёрный список целей ────────────────────────────────────────────
export async function fetchBlacklist(): Promise<string[]> {
  const data = await apiGet<{ entries: string[] }>('/api/target-blacklist')
  return data.entries
}

export async function setBlacklist(entries: string[]): Promise<string[]> {
  const data = await apiPost<{ entries: string[] }>('/api/target-blacklist', { entries })
  return data.entries
}

export async function addBlacklistEntry(entry: string | string[]): Promise<string[]> {
  const data = await apiPost<{ entries: string[] }>('/api/target-blacklist', { entry })
  return data.entries
}

export async function removeBlacklistEntry(entry: string): Promise<string[]> {
  // §12 (MR-58): через apiDelete (с auth-заголовками). Голый fetch без них не проходил
  // серверную проверку на проде → запись из ЧС не удалялась (добавить можно, убрать нет).
  const data = await apiDelete<{ entries: string[] }>('/api/target-blacklist', { entry })
  return data.entries
}

// ── (5) Папки списков целей ─────────────────────────────────────────────
export interface TargetFolder {
  id: string
  name: string
  targets: string[]
  createdAt: number
  updatedAt: number
}

export async function fetchFolders(): Promise<TargetFolder[]> {
  const data = await apiGet<{ folders: TargetFolder[] }>('/api/target-folders')
  return data.folders
}

export async function createFolder(name: string, targets: string[]): Promise<TargetFolder> {
  const data = await apiPost<{ folder: TargetFolder }>('/api/target-folders', { name, targets })
  return data.folder
}

export async function updateFolder(id: string, patch: { name?: string; targets?: string[] }): Promise<TargetFolder> {
  // §12 (MR-57): через apiPut — с auth-заголовками (Authorization + X-User-Id). Голый fetch
  // без них на проде (SESSION_SECRET) не проходил серверную проверку → переименование/дозапись
  // «не работали». Теперь как все остальные вызовы.
  const data = await apiPut<{ folder: TargetFolder }>(`/api/target-folders/${id}`, patch)
  return data.folder
}

export async function deleteFolder(id: string): Promise<void> {
  // §12 (MR-57): через apiDelete — с auth-заголовками; голый fetch без них не проходил и
  // удаление молча не срабатывало.
  await apiDelete(`/api/target-folders/${id}`)
}

export interface ValidateResult { checked: number; kept: number; removed: number; folder: TargetFolder }

/** Проверяет цели папки в Telegram и удаляет «мёртвые». */
export async function validateFolder(id: string): Promise<ValidateResult> {
  const data = await apiPost<ValidateResult>(`/api/target-folders/${id}/validate`)
  return data
}

// ── MR-185: тексты промптов модулей — из базы, по владельцу ─────────────
//
// Раньше лежали в памяти браузера без имени владельца: правка одного человека
// доставалась всем, кто заходит с этого компьютера, а со своего второго устройства он
// своих правок не видел. Теперь владелец берётся из сессии на сервере.

/** Изменённые промпты текущего пользователя: номер карточки → текст. Заводские не приходят. */
export async function fetchUserPrompts(moduleKey: string): Promise<Record<number, string>> {
  const data = await apiGet<{ prompts: Record<string, string> }>(`/api/prompts?moduleKey=${encodeURIComponent(moduleKey)}`)
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(data.prompts || {})) out[Number(k)] = String(v)
  return out
}

/**
 * Сохранить набор карточек модуля. Шлём ПОЛНЫЙ список и заводские тексты рядом: сервер
 * сам отличит изменённое от возвращённого к заводскому и не станет хранить копии дефолтов.
 */
export async function saveUserPrompts(moduleKey: string, bodies: string[], defaults: string[]): Promise<void> {
  await apiPut('/api/prompts', { moduleKey, bodies, defaults })
}
