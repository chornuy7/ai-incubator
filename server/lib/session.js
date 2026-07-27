/**
 * Подписанные сессии операторов (продакшн-замена «голого» X-User-Id, CONTRACT-rbac §7).
 *
 * Токен — stateless HMAC: `base64url(userId).exp.hmac`. Подпись покрывает `userId.exp`
 * секретом `SESSION_SECRET`. Подделать личность нельзя: без секрета не собрать валидную
 * подпись, а срок в токене не даёт использовать его вечно.
 *
 * ⚠️ Замок включается ТОЛЬКО когда задан `SESSION_SECRET`. Без него (локальная разработка,
 * тесты) `authEnforced()` = false и всё работает как раньше (дев/демо). Так прод
 * защищён, а 524 теста и локальный запуск не ломаются.
 */
import crypto from 'node:crypto'

/** Срок жизни токена. Неделя — достаточно для рабочей сессии, не вечный. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const secret = () => process.env.SESSION_SECRET || ''

/** Включён ли серверный enforcement входа (есть секрет подписи). */
export function authEnforced() {
  return !!secret()
}

/**
 * Выдать токен для пользователя. Пустая строка, если секрета нет (дев).
 * @param {string} userId @param {number} [now]
 */
export function signSession(userId, now = Date.now()) {
  const s = secret()
  if (!s || !userId) return ''
  const exp = now + SESSION_TTL_MS
  const sig = crypto.createHmac('sha256', s).update(`${userId}.${exp}`).digest('base64url')
  return `${Buffer.from(String(userId)).toString('base64url')}.${exp}.${sig}`
}

/**
 * Проверить токен. Возвращает { userId, exp } или null (нет секрета / кривой /
 * просроченный / подпись не сошлась).
 * @param {string} token @param {number} [now]
 */
export function verifySession(token, now = Date.now()) {
  const s = secret()
  if (!s || !token) return null
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  const [uidB64, expStr, sig] = parts
  let userId
  try { userId = Buffer.from(uidB64, 'base64url').toString('utf8') } catch { return null }
  const exp = Number(expStr)
  if (!userId || !Number.isFinite(exp)) return null
  const expected = crypto.createHmac('sha256', s).update(`${userId}.${exp}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  // Константное сравнение — не даём подобрать подпись по времени ответа.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  if (now > exp) return null
  return { userId, exp }
}
