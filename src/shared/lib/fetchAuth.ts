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
    let token = ''
    let uid = ''
    try {
      token = localStorage.getItem('ai-incubator:token') || ''
      const raw = localStorage.getItem('ai-incubator:session')
      if (raw) uid = (JSON.parse(raw) as { id?: string })?.id || ''
    } catch { /* ignore */ }
    if (!token && !uid) return orig(input, init)

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    // Ключи API v1 (aii_live_sk_) фронт не шлёт — если Authorization уже стоит, не трогаем.
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    if (uid && !headers.has('X-User-Id')) headers.set('X-User-Id', uid)
    return orig(input, { ...init, headers })
  }) as typeof window.fetch
}
