import { apiGet, apiPost } from './client'

/** §2: массовый импорт аккаунтов из tdata / .session. */

export interface ScannedAccount {
  kind: 'tdata' | 'session-file'
  path: string
  name: string
  accountIdx?: number
  phone: string | null
  proxy: string | null
  twoFA: string | null
  /** Такой телефон уже заведён в системе — по умолчанию не отмечаем. */
  known?: boolean
}

export interface BrowseResult {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

/** Проводник по папкам сервера. Пустой путь = список дисков (C:\, D:\ …). */
export async function browseDirs(path: string): Promise<BrowseResult> {
  return apiPost<BrowseResult>('/api/tg/import/browse', { path })
}

export async function scanFolder(path: string, passcode?: string): Promise<{ items: ScannedAccount[]; scannedDirs: number; tdata: number; files: number }> {
  return apiPost('/api/tg/import/scan', { path, passcode })
}

export type ProxyMode = 'pool' | 'single' | 'sidecar' | 'none'

export interface ImportRunInput {
  items: ScannedAccount[]
  proxyMode: ProxyMode
  proxyIds?: string[]
  singleProxy?: string
  /** Зайти в Telegram каждой сессией — единственный способ узнать, живая ли она. */
  validate?: boolean
  passcode?: string
}

export interface ImportResultRow {
  name: string
  ok: boolean
  accountId?: string
  phone?: string
  proxy?: string | null
  reason?: string
}

export async function runImport(input: ImportRunInput): Promise<{ results: ImportResultRow[]; imported: number; failed: number }> {
  return apiPost('/api/tg/import/run', input)
}

/** Сколько прокси свободно под импорт (правило §6: один прокси — один аккаунт). */
export async function proxyCapacity(): Promise<{ total: number; free: number; freeIds: string[] }> {
  return apiGet('/api/tg/import/proxy-capacity')
}
