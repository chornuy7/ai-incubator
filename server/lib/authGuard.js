/**
 * Глобальный вход для всего /api (продакшн-замок).
 *
 * Монтируется ДО всех /api-роутов. Делает две вещи:
 *  1) личность берётся ТОЛЬКО из подписанного токена — присланный клиентом X-User-Id
 *     срезаем (иначе любой подставил бы `usr_admin` и стал админом);
 *  2) при включённом enforcement (есть SESSION_SECRET) — нет валидной сессии → 401,
 *     кроме публичного списка (лендинг тянет цены, вход/регистрация, API v1 по ключу).
 *
 * Существующий RBAC (`accessGuard.js`, `moduleAccessGuard` и т.д.) читает `x-user-id` —
 * поэтому проверенный id мы кладём обратно в этот заголовок. Весь RBAC продолжает
 * работать как есть, но теперь на доверенной личности.
 */
import { verifySession, authEnforced } from './session.js'
import { touch, isRevoked } from './tokenRevocation.js'

/** Достать токен сессии из запроса. API-ключи (aii_live_sk_) — не сюда. */
function tokenFrom(req) {
  const h = req.header('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  const bearer = m ? m[1].trim() : ''
  if (bearer && !bearer.startsWith('aii_live_sk_')) return bearer
  const x = req.header('x-session-token')
  return x ? x.trim() : ''
}

/**
 * Публичные маршруты — доступны БЕЗ входа:
 *  - health;
 *  - вход и регистрация (иначе не залогиниться);
 *  - цены (лендинг показывает их гостю);
 *  - /api/v1 — своя защита по API-ключу (fail-closed внутри apiV1).
 */
const PUBLIC = [
  ['GET', /^\/api\/health(\/|$|\?)/],
  ['POST', /^\/api\/users\/login(\/|$|\?)/],
  ['POST', /^\/api\/users\/register(\/|$|\?)/],
  ['GET', /^\/api\/subscription(\/|$|\?)/],
  ['ALL', /^\/api\/v1(\/|$|\?)/],
]

function isPublic(req) {
  if (req.method === 'OPTIONS') return true // CORS preflight
  const url = req.originalUrl || req.url
  return PUBLIC.some(([m, re]) => (m === 'ALL' || m === req.method) && re.test(url))
}

/** Express-middleware: монтировать `app.use('/api', sessionGuard)` перед роутами. */
export function sessionGuard(req, res, next) {
  // Клиент — не доверенный источник личности: срезаем присланный id.
  delete req.headers['x-user-id']
  let sess = verifySession(tokenFrom(req))
  // MR-203: подписи и срока мало — токен мог быть погашен выходом. Карта отзывов
  // прогревается на старте (index.js) и освежается фоном, поэтому проверка бесплатна.
  if (sess) {
    touch()
    if (isRevoked(sess.userId, sess.iat)) sess = null
  }
  if (sess) req.headers['x-user-id'] = sess.userId

  if (!authEnforced()) return next() // дев/тесты: без секрета замок выключен

  if (isPublic(req)) return next()
  if (!sess) return res.status(401).json({ ok: false, error: 'Требуется вход' })
  next()
}
