/**
 * Сущность «Прокси» (§3.2/3.4). Каталог прокси для привязки к аккаунтам.
 * Модель поддерживает решение заказчика (14.07): своя ферма + докупаемые (static/mobile).
 * account.proxy хранит URL-строку (её парсит server/proxy.js#parseProxy для GramJS);
 * `toProxyUrl` строит эту строку из сущности — мост между каталогом и назначением на аккаунт.
 * Хранение — JSON data/proxies.json; путь через env PROXIES_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const PROXIES_FILE = process.env.PROXIES_FILE || dataPath('proxies.json')

export const PROXY_KINDS = ['static', 'mobile', 'farm'] // статический / мобильный / своя ферма
export const PROXY_SCHEMES = ['socks5', 'http']
export const PROXY_STATUSES = ['ok', 'dead', 'unknown']

/** Построить URL-строку прокси (совместимо с parseProxy). @param {object} p */
export function toProxyUrl(p) {
  if (!p || !p.host || !p.port) return ''
  const scheme = PROXY_SCHEMES.includes(p.scheme) ? p.scheme : 'socks5'
  const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@` : ''
  return `${scheme}://${auth}${p.host}:${p.port}`
}

/** Нормализовать вход в чистую запись прокси. @param {object} input */
export function normalizeProxy(input = {}) {
  return {
    label: String(input.label ?? '').trim(),
    kind: PROXY_KINDS.includes(input.kind) ? input.kind : 'static',
    scheme: PROXY_SCHEMES.includes(input.scheme) ? input.scheme : 'socks5',
    host: String(input.host ?? '').trim(),
    port: Math.max(0, Math.floor(Number(input.port) || 0)),
    username: String(input.username ?? '').trim(),
    password: String(input.password ?? ''),
    country: String(input.country ?? '').trim().toLowerCase(),
    status: PROXY_STATUSES.includes(input.status) ? input.status : 'unknown',
    note: String(input.note ?? ''),
  }
}

export async function listProxies() {
  const arr = await readJson(PROXIES_FILE, [])
  return Array.isArray(arr) ? arr : []
}

export async function getProxy(id) {
  return (await listProxies()).find((p) => p.id === id) || null
}

/** @param {object} input @throws при пустом host/port */
export async function createProxy(input) {
  const clean = normalizeProxy(input)
  if (!clean.host || !clean.port) throw new Error('Укажите host и port')
  const all = await listProxies()
  const proxy = {
    id: `px_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    lastCheckAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(proxy)
  await writeJson(PROXIES_FILE, all)
  return proxy
}

/** @param {string} id @param {object} patch */
export async function updateProxy(id, patch = {}) {
  const all = await listProxies()
  const i = all.findIndex((p) => p.id === id)
  if (i === -1) return null
  const clean = normalizeProxy({ ...all[i], ...patch })
  if (!clean.host || !clean.port) throw new Error('Host и port обязательны')
  all[i] = { ...all[i], ...clean, updatedAt: Date.now() }
  await writeJson(PROXIES_FILE, all)
  return all[i]
}

export async function deleteProxy(id) {
  const all = await listProxies()
  const next = all.filter((p) => p.id !== id)
  if (next.length === all.length) return false
  await writeJson(PROXIES_FILE, next)
  return true
}
