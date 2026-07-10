import { apiGet, apiPost } from './client'

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
  const res = await fetch('/api/target-blacklist', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry }),
  })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.entries as string[]
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
  const res = await fetch(`/api/target-folders/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.folder as TargetFolder
}

export async function deleteFolder(id: string): Promise<void> {
  const res = await fetch(`/api/target-folders/${id}`, { method: 'DELETE' })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
}

export interface ValidateResult { checked: number; kept: number; removed: number; folder: TargetFolder }

/** Проверяет цели папки в Telegram и удаляет «мёртвые». */
export async function validateFolder(id: string): Promise<ValidateResult> {
  const data = await apiPost<ValidateResult>(`/api/target-folders/${id}/validate`)
  return data
}
