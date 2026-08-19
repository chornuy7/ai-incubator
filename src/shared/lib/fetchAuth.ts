import { currentToken, currentUid } from '@/features/auth/zone'
import { useUi } from '@/shared/lib/uiStore'

// MR-153 (флуд): когда доступ отключён (accessBlocked), фоновые поллеры (баланс, задачи,
// тикеты, статистика…) продолжают лупить /api — сервер на каждый отвечает 403, и это
// десятки запросов в секунду = лишняя нагрузка. Гасим их ЛОКАЛЬНО синтетическим 403 без
// сетевого запроса. Пропускаем только whitelist — те же пути, что и accessGate.js на сервере
// (свой профиль/подписка/поддержка/me): их отключённому человеку МОЖНО, и через /me панель
// узнаёт, что доступ вернули.
const ALLOWED_WHEN_DISABLED = [
  /^\/api\/health/, /^\/api\/session/, /^\/api\/users\/(login|logout|register|me)/,
  /^\/api\/me/, /^\/api\/profile/, /^\/api\/subscription/, /^\/api\/billing/,
  /^\/api\/pricing/, /^\/api\/tickets/,
]
function pathOf(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return new URL(raw, window.location.origin).pathname
  } catch { return '' }
}
function shortCircuitBlocked(input: RequestInfo | URL): Response | null {
  const msg = useUi.getState().accessBlocked
  if (!msg) return null
  const p = pathOf(input)
  if (ALLOWED_WHEN_DISABLED.some((re) => re.test(p))) return null
  return new Response(JSON.stringify({ ok: false, code: 'ACCESS_DISABLED', error: msg }),
    { status: 403, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Глобальная auth-обёртка над fetch.
 *
 * После включения серверного замка (fail-closed на /api) любой запрос без токена
 * получает 401. Часть кода ходит через apiGet/apiPost (там токен добавляется), но
 * десятки мест зовут `fetch('/api/…')` напрямую — они бы молча падали на проде.
 * Вместо правки каждого места ставим обёртку один раз: на КАЖДЫЙ same-origin запрос
 * к `/api` подкладываем `Authorization: Bearer <токен>` (и `X-User-Id` для дев-режима),
 * если их ещё нет. Локально (без SESSION_SECRET) это ни на что не влияет.
 */
export function installFetchAuth() {
  if (typeof window === 'undefined' || (window as unknown as { __authFetch?: boolean }).__authFetch) return
  ;(window as unknown as { __authFetch?: boolean }).__authFetch = true

  const orig = window.fetch.bind(window)

  const isApi = (input: RequestInfo | URL): boolean => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      // Только наши API-пути (относительные или на этот же origin). Внешние — не трогаем.
      if (url.startsWith('/api/')) return true
      const u = new URL(url, window.location.origin)
      return u.origin === window.location.origin && u.pathname.startsWith('/api/')
    } catch { return false }
  }

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isApi(input)) return orig(input, init)
    // MR-153: доступ отключён → не-whitelist запросы гасим локально (без сети), не грузим сервер.
    const sc = shortCircuitBlocked(input)
    if (sc) return Promise.resolve(sc)
    // Токен и id — ПО ЗОНЕ (панель/админка): у каждой свой (созвон 19.08).
    const token = currentToken()
    const uid = currentUid()
    if (!token && !uid) return orig(input, init)

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    // Ключи API v1 (aii_live_sk_) фронт не шлёт — если Authorization уже стоит, не трогаем.
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    if (uid && !headers.has('X-User-Id')) headers.set('X-User-Id', uid)
    return orig(input, { ...init, headers })
  }) as typeof window.fetch
}
