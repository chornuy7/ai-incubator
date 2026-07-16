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

/** Проверить прокси (liveness) + определить страну/город по IP (§3.4). */
export async function checkProxy(id: string): Promise<{ proxy: Proxy; geo: ProxyGeo | null }> {
  return apiPost<{ proxy: Proxy; geo: ProxyGeo | null }>(`/api/proxies/${id}/check`)
}
