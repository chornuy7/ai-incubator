import { useEffect, useRef } from 'react'

/**
 * §10.2: виджет Cloudflare Turnstile (капча). Загружает скрипт Cloudflare один раз,
 * рендерит виджет и отдаёт токен через onToken. Токен уходит на сервер и там
 * проверяется (server/lib/turnstile.js). Виджет показывается только если капча
 * включена (заданы ключи) — иначе форма как раньше.
 */

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  remove: (id: string) => void
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let scriptPromise: Promise<void> | null = null
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('turnstile script failed'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadTurnstileScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
    }).catch(() => { /* нет сети/скрипта — просто не покажем виджет */ })
    return () => {
      cancelled = true
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch { /* уже снят */ }
      }
    }
    // siteKey стабилен на время формы; onToken — колбэк родителя, ремонтировать виджет не нужно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey])

  return <div ref={ref} className="flex justify-center" />
}
