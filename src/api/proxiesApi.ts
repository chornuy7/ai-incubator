import { apiGet, apiPost, apiPut, apiDelete } from './client'

export type ProxyKind = 'static' | 'mobile' | 'farm'
export type ProxyScheme = 'socks5' | 'http'
export type ProxyStatus = 'ok' | 'dead' | 'unknown'

export interface Proxy {
  id: string
  label: string
  kind: ProxyKind
  scheme: ProxyScheme
  host: string
  port: number
  username: string
  password: string
  country: string
  status: ProxyStatus
  note: string
  lastCheckAt: number | null
  createdAt: number
  updatedAt: number
}

export const PROXY_KIND_LABELS: Record<ProxyKind, string> = {
  static: 'Статический',
  mobile: 'Мобильный',
  farm: 'Своя ферма',
}

/** URL-строка прокси (совместимо с account.proxy / server parseProxy). */
export function toProxyUrl(p: Pick<Proxy, 'scheme' | 'host' | 'port' | 'username' | 'password'>): string {
  if (!p.host || !p.port) return ''
  const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@` : ''
  return `${p.scheme}://${auth}${p.host}:${p.port}`
}

export async function fetchProxies(): Promise<Proxy[]> {
  const data = await apiGet<{ proxies: Proxy[] }>('/api/proxies')
  return data.proxies
}

export async function createProxy(input: Partial<Proxy>): Promise<Proxy> {
  const data = await apiPost<{ proxy: Proxy }>('/api/proxies', input)
  return data.proxy
}

export async function updateProxy(id: string, patch: Partial<Proxy>): Promise<Proxy> {
  const data = await apiPut<{ proxy: Proxy }>(`/api/proxies/${id}`, patch)
  return data.proxy
}

export async function deleteProxy(id: string): Promise<void> {
  await apiDelete(`/api/proxies/${id}`)
}

export interface ProxyGeo { country: string; countryName: string; city: string; isp: string; ip: string }
/** exit — гео реального выходного IP (через прокси); gateway — гео адреса шлюза (запасной вариант). */
export type GeoSource = 'exit' | 'gateway' | null

/** Проверить прокси (liveness) + определить страну/город ВЫХОДНОГО IP через прокси (§3.4). */
export async function checkProxy(id: string): Promise<{ proxy: Proxy; geo: ProxyGeo | null; geoSource?: GeoSource; ms?: number | null }> {
  return apiPost<{ proxy: Proxy; geo: ProxyGeo | null; geoSource?: GeoSource; ms?: number | null }>(`/api/proxies/${id}/check`)
}

/** Реальная проверка прокси по host:port ДО сохранения — TCP-пинг + гео выхода (§3.4). */
export async function probeProxy(input: { host: string; port: number; scheme?: string; username?: string; password?: string }): Promise<{ alive: boolean; ms: number; geo: ProxyGeo | null; geoSource?: GeoSource }> {
  return apiPost<{ alive: boolean; ms: number; geo: ProxyGeo | null; geoSource?: GeoSource }>('/api/proxies/probe', input)
}

// ── §3.2: массовый импорт ──

export interface ParsedProxyLine { scheme: ProxyScheme; host: string; port: number; username: string; password: string; raw: string }
export interface ImportIssue { line?: number; raw: string; reason: string }

/** Разобрать список без записи в базу — показать, что понято, до импорта. */
export async function previewProxyImport(text: string, scheme?: ProxyScheme): Promise<{ items: ParsedProxyLine[]; errors: ImportIssue[]; total: number; duplicates: number }> {
  return apiPost('/api/proxies/import/preview', { text, scheme })
}

export interface ProxyImportInput {
  text: string
  scheme?: ProxyScheme
  kind?: ProxyKind
  /** Метка в имени: «USA {tag} 1». */
  tag?: string
  /** Шаблон имени. Плейсхолдеры: {country} {tag} {n} {host} {port}. */
  template?: string
  /** Определять страну и живость по реальному выходному IP (медленнее, но имена осмысленные). */
  probe?: boolean
  note?: string
}

export async function importProxies(input: ProxyImportInput): Promise<{ created: Proxy[]; skipped: ImportIssue[]; errors: ImportIssue[]; alive: number; dead: number }> {
  return apiPost('/api/proxies/import', input)
}
