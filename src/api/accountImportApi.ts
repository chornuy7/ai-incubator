import { apiGet, apiPost, authHeaders } from './client'

/** §2: массовый импорт аккаунтов из tdata / .session. */

export interface ScannedAccount {
  kind: 'tdata' | 'session-file'
  path: string
  name: string
  accountIdx?: number
  phone: string | null
  proxy: string | null
  twoFA: string | null
  /** Запасной источник: `.session` рядом с tdata — заведём из него, если tdata под паролем. */
  altSession?: string | null
  /** Локальный пароль tdata (passcode) для этого аккаунта — из списка/поля в форме. */
  passcode?: string
  /** Такой телефон уже заведён в системе — по умолчанию не отмечаем. */
  known?: boolean
}

export interface BrowseResult {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

/**
 * Что доступно в текущем окружении. `localFs=false` (прод) — проводник по диску
 * сервера выключен, остаётся только загрузка папки с ПК пользователя.
 */
export async function importCapabilities(): Promise<{ localFs: boolean }> {
  return apiGet('/api/tg/import/capabilities')
}

/** Проводник по папкам сервера. Пустой путь = список дисков (C:\, D:\ …). */
export async function browseDirs(path: string): Promise<BrowseResult> {
  return apiPost<BrowseResult>('/api/tg/import/browse', { path })
}

export async function scanFolder(path: string, passcode?: string): Promise<{ items: ScannedAccount[]; scannedDirs: number; tdata: number; files: number }> {
  return apiPost('/api/tg/import/scan', { path, passcode })
}

export type ProxyMode = 'pool' | 'single' | 'sidecar' | 'manual' | 'none'

export interface ImportRunInput {
  items: ScannedAccount[]
  proxyMode: ProxyMode
  /** Раскладка «аккаунт ↔ прокси» из таблицы — для режима `manual`. */
  manualProxies?: (string | null)[]
  proxyIds?: string[]
  singleProxy?: string
  /** Зайти в Telegram каждой сессией — единственный способ узнать, живая ли она. */
  validate?: boolean
  passcode?: string
  /** Папка, которую сканировали: сервер не пустит импорт из путей вне неё. */
  root?: string
  /**
   * Завести аккаунты ПЛАТФОРМЕ, а не своему пространству: они не попадут в клиентские
   * списки и смогут дежурить по ревизии общей базы. Только администратору.
   */
  forPlatform?: boolean
}

/**
 * Залить папку через браузер и сразу просканировать. Нужно, когда бэкенд не на той
 * машине, где лежат аккаунты (удалённый сервер) — локально дешевле указать путь.
 *
 * `relPaths` — относительные пути внутри папки (для drag-and-drop, где у File нет
 * `webkitRelativePath`). Если не заданы — берём `webkitRelativePath` (выбор папки кнопкой).
 */
export async function uploadFolder(files: File[], relPaths?: string[]): Promise<{ token: string; root: string; items: ScannedAccount[]; scannedDirs: number; tdata: number; files: number }> {
  const fd = new FormData()
  files.forEach((f, i) => {
    fd.append('files', f)
    // Путь внутри выбранной папки — по нему сервер восстановит дерево tdata.
    const rel = relPaths?.[i] || (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    fd.append('paths', rel)
  })
  // FormData: заголовки авторизации ставим сами (Content-Type НЕ трогаем — браузер сам
  // выставит multipart-boundary). Без токена сервер отвечал бы 401 при активной авторизации.
  const res = await fetch('/api/tg/import/upload', { method: 'POST', headers: authHeaders(), body: fd })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || 'Загрузка не удалась')
  return data
}

/**
 * Рекурсивно собрать файлы папки из drag-and-drop (FileSystem Entry API) вместе с их
 * относительными путями. Перетаскивание НЕ показывает нативный попап «загрузить N
 * файлов», в отличие от выбора папки кнопкой — ради этого и городим обход дерева.
 */
export async function collectDroppedEntries(entry: FileSystemEntry, base = ''): Promise<{ file: File; path: string }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    return [{ file, path: base + entry.name }]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const all: FileSystemEntry[] = []
  // readEntries отдаёт порциями — читаем, пока не кончатся.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) break
    all.push(...batch)
  }
  const out: { file: File; path: string }[] = []
  for (const e of all) out.push(...await collectDroppedEntries(e, `${base}${entry.name}/`))
  return out
}

/** Удалить залитую пачку с сервера — после импорта или отмены. */
export async function cleanupUpload(token: string): Promise<void> {
  await apiPost(`/api/tg/import/upload/${token}/cleanup`, {})
}

export interface ImportResultRow {
  name: string
  ok: boolean
  accountId?: string
  phone?: string
  proxy?: string | null
  reason?: string
  /** Облачный пароль сохранён вместе с аккаунтом. */
  has2fa?: boolean
  /** У аккаунта включена 2FA, но пароля мы не знаем — реавторизация будет невозможна. */
  needsPassword?: boolean
}

export async function runImport(input: ImportRunInput): Promise<{ results: ImportResultRow[]; imported: number; failed: number }> {
  return apiPost('/api/tg/import/run', input)
}

/** Сколько прокси свободно под импорт (правило §6: один прокси — один аккаунт). */
export async function proxyCapacity(): Promise<{ total: number; free: number; freeIds: string[] }> {
  return apiGet('/api/tg/import/proxy-capacity')
}

export interface PairPoolItem { url: string; country?: string; status?: string; used?: number }

/**
 * Предложенная раскладка «аккаунт ↔ прокси» перед импортом. Считает сервер: правило
 * одно на систему и покрыто тестами, форма только показывает и даёт поправить.
 */
export async function pairPreview(input: {
  accounts: { name?: string; phone?: string | null; country?: string }[]
  proxyUrls?: string[]
  matchGeo?: boolean
  skipDead?: boolean
}): Promise<{ pairs: (string | null)[]; pool: PairPoolItem[]; shortage: number }> {
  return apiPost('/api/tg/import/pair-preview', input)
}

export interface AssignProxyRow {
  accountId: string
  ok: boolean
  proxy?: string | null
  reason?: string
}

/**
 * Массово привязать прокси к УЖЕ ЗАЛИТЫМ аккаунтам: пул сдох, купили новый,
 * аккаунты переехали. До этого раздача была только в момент импорта, а дальше —
 * руками по одному через карточку.
 */
export async function assignProxies(input: {
  accountIds: string[]
  mode: 'pool' | 'single' | 'none'
  proxyIds?: string[]
  singleProxy?: string
}): Promise<{ applied: number; rows: AssignProxyRow[] }> {
  return apiPost('/api/tg/import/assign-proxies', input)
}
