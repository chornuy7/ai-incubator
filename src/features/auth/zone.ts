/**
 * Разделение сессий панели и админки (созвон 19.08: «вошёл в админке и в панели — они
 * должны быть разными»).
 *
 * Раньше обе зоны сидели на ОДНОМ токене (`ai-incubator:token`) и одной записи сессии,
 * поэтому «Выйти» из панели убивал и админку. Теперь у каждой зоны — свой токен и своя
 * запись сессии; выбор ключа делаем по текущему пути (`/admin*` → админ-зона).
 *
 * Тот же аккаунт может быть залогинен в обеих зонах независимо: выход из одной не трогает
 * другую. Токен на зону выбирается в момент запроса — так фоновые опросы панели и админки
 * шлют каждый свой токен.
 */
export const PANEL_TOKEN_KEY = 'ai-incubator:token'
export const ADMIN_TOKEN_KEY = 'ai-incubator:admin-token'
export const PANEL_SESSION_KEY = 'ai-incubator:session'
export const ADMIN_SESSION_KEY = 'ai-incubator:admin-session'

/** Мы сейчас в админ-зоне? Определяем по URL: /admin и вложенные. */
export function isAdminZone(): boolean {
  try { return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') } catch { return false }
}

export function tokenKey(): string { return isAdminZone() ? ADMIN_TOKEN_KEY : PANEL_TOKEN_KEY }
export function sessionKey(): string { return isAdminZone() ? ADMIN_SESSION_KEY : PANEL_SESSION_KEY }

/** Токен ТЕКУЩЕЙ зоны (для Authorization). */
export function currentToken(): string {
  try { return localStorage.getItem(tokenKey()) || '' } catch { return '' }
}

/** id пользователя ТЕКУЩЕЙ зоны (для заголовка x-user-id в деве без токена). */
export function currentUid(): string {
  try {
    const raw = localStorage.getItem(sessionKey())
    return raw ? ((JSON.parse(raw) as { id?: string })?.id || '') : ''
  } catch { return '' }
}
