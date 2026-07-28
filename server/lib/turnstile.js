/**
 * §10.2: капча на регистрацию — Cloudflare Turnstile (бесплатная, почти невидимая).
 *
 * Замок включается ТОЛЬКО когда заданы оба ключа `TURNSTILE_SITE_KEY` и `TURNSTILE_SECRET`
 * (как SESSION_SECRET): без них регистрация работает как раньше — так прод защищён, а
 * локальный запуск и тесты не ломаются. Для проверки можно поставить ТЕСТОВЫЕ ключи
 * Cloudflare (сайт `1x00000000000000000000AA`, секрет `1x0000000000000000000000000000000AA`),
 * которые всегда проходят; в релизе заменить на реальные из дашборда Cloudflare.
 */
const SITE_KEY = () => process.env.TURNSTILE_SITE_KEY?.trim() || ''
const SECRET = () => process.env.TURNSTILE_SECRET?.trim() || ''

/** Включена ли капча (заданы оба ключа) + публичный site-key для фронта. */
export function turnstileConfig() {
  return { enabled: !!SITE_KEY() && !!SECRET(), siteKey: SITE_KEY() }
}

/**
 * Проверить токен капчи у Cloudflare. Если капча не настроена (нет секрета) — пропускаем
 * (true), чтобы поведение без ключей не менялось. Ошибка сети/таймаут → false (fail-closed:
 * лучше не пустить сомнительную регистрацию, чем пропустить бота).
 * @param {string} token значение от виджета Turnstile (cf-turnstile-response)
 * @param {string} [ip] IP клиента (необязательно)
 * @returns {Promise<boolean>}
 */
export async function verifyTurnstile(token, ip) {
  if (!SECRET()) return true // не настроено — не требуем
  if (!token) return false
  try {
    const body = new URLSearchParams({ secret: SECRET(), response: String(token) })
    if (ip) body.set('remoteip', String(ip))
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(10000),
    })
    const data = await res.json()
    return !!data?.success
  } catch {
    return false
  }
}
