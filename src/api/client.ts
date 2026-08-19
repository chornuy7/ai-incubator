import { useUi } from '@/shared/lib/uiStore'
import { currentToken, currentUid } from '@/features/auth/zone'

/**
 * Ошибка API вместе с телом ответа.
 *
 * Обычный `Error` доносит только текст, и всё остальное терялось: например список
 * аккаунтов, из-за которых запуск не прошёл. Из-за этого пользователю показывали
 * «нельзя назначить профили» без возможности что-то сделать прямо там.
 */
export class ApiError<T = Record<string, unknown>> extends Error {
  readonly status: number
  readonly data: T
  constructor(message: string, status: number, data: T) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  const ct = res.headers.get('content-type') || ''
  if (text.trimStart().startsWith('<') || (!ct.includes('json') && text && !text.trimStart().startsWith('{'))) {
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      // Сервер вернул HTML вместо JSON — запрос ушёл не на API, а на статику (SPA-фолбэк).
      // В деве это значит «бэкенд не поднят», а на проде — «этого роута нет в задеплоенном
      // бэкенде» (фронт новее сервера) или идёт обновление. Совет про `npm run dev` на проде
      // вводил в заблуждение, поэтому текст зависит от среды. Среду берём по hostname:
      // vite-типы (import.meta.env) в проекте не подключены, а location тут всегда есть.
      const isLocal = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(location.hostname)
      throw new Error(
        isLocal
          ? 'API недоступен — перезапустите npm run dev (нужны web + api на :5173 и :3001)'
          : 'API-сервер не отвечает на этот запрос — вероятно, идёт обновление или сервер устарел. Обновите страницу через минуту; если не пройдёт — сообщите администратору.',
      )
    }
    throw new Error(text.slice(0, 160) || `HTTP ${res.status}`)
  }
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Некорректный ответ API (HTTP ${res.status})`)
  }
  if (!res.ok || (data && typeof data === 'object' && 'ok' in data && !(data as { ok?: boolean }).ok)) {
    // Нулевой баланс — ошибка, которую нельзя «закрыть и забыть»: без пополнения
    // не заработает ни один модуль. Поднимаем окно по центру из одного места,
    // чтобы каждый экран не переоткрывал его по-своему.
    //
    // ВАЖНО: только needTopUp. Тем же 402 отвечает неоплаченный модуль, и раньше
    // на него открывалось окно «Недостаточно монет» с кнопкой «Пополнить баланс» —
    // человека слали пополнять деньги, когда дело было в подписке.
    if ((data as { needTopUp?: boolean })?.needTopUp) {
      const msg = (data as { error?: string }).error || 'Закончились монеты.'
      useUi.getState().setNoCoins(msg)
    }
    if ((data as { needSubscription?: boolean })?.needSubscription) {
      const msg = (data as { error?: string }).error || 'Модуль не оплачен.'
      useUi.getState().setNoSubscription(msg)
    }
    // MR-153: доступ отключён администратором (accessGate вернул 403 ACCESS_DISABLED на
    // любой не-whitelisted запрос). Поднимаем поп-ап-блок с blur из одного места — иначе
    // панель просто сыпала бы 403 по всем виджетам, а человек не понимал бы, что закрыт.
    if ((data as { code?: string })?.code === 'ACCESS_DISABLED') {
      const msg = (data as { error?: string }).error || 'Доступ отключён.'
      useUi.getState().setAccessBlocked(msg)
    }
    throw new ApiError(
      (data as { error?: string }).error || `HTTP ${res.status}`,
      res.status,
      (data ?? {}) as Record<string, unknown>,
    )
  }
  return data as T
}

/**
 * Заголовки идентификации для серверного RBAC (§8.1) + продакшн-сессии.
 *
 * На проде решает подписанный токен (`Authorization: Bearer`) — его сервер проверяет
 * и сам ставит доверенный `x-user-id`. Присланный нами `X-User-Id` на проде срезается
 * (подделать нельзя), но в дев-режиме (без SESSION_SECRET) он остаётся как личность —
 * поэтому шлём оба: токен для прода, id для локальной разработки.
 */
export function authHeaders(base?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(base ?? {}) }
  try {
    // Токен и id берём ПО ЗОНЕ (панель/админка) — у каждой свой (созвон 19.08).
    const uid = currentUid()
    if (uid) headers['X-User-Id'] = uid
    const token = currentToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch { /* ignore */ }
  return headers
}

export async function apiGet<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(), signal: opts?.signal })
  return parseJson<T>(res)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  // Тело у DELETE опционально (напр. чёрный список удаляет конкретную запись по body).
  // Заголовки авторизации ставим всегда — без них серверные проверки на проде не проходят.
  const res = await fetch(path, {
    method: 'DELETE',
    headers: body !== undefined ? authHeaders({ 'Content-Type': 'application/json' }) : authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}
