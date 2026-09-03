/**
 * §10 (MR-51): различаем окружения development и production по хосту.
 *
 * Vite-типы `import.meta.env` в проекте не подключены (см. api/client.ts), а `PROD`
 * в собранном билде true и для dev-стенда, и для боевого — по нему их не отличить.
 * Поэтому окружение определяем по домену: localhost и поддомены `dev.*` — development
 * (там доступны dev-инструменты и явная метка), всё остальное — production.
 */
export function isDevEnv(): boolean {
  if (typeof location === 'undefined') return true // SSR/тесты — считаем dev
  const h = location.hostname
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(h) || h.startsWith('dev.') || h.includes('.dev.')
}

export function isProdEnv(): boolean {
  return !isDevEnv()
}

/** Короткая метка окружения для индикатора. */
export function envLabel(): 'DEV' | 'PROD' {
  return isDevEnv() ? 'DEV' : 'PROD'
}
