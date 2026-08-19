import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Lock, LifeBuoy, User, LogOut } from 'lucide-react'
import { useUi } from '@/shared/lib/uiStore'
import { useSession } from '@/features/auth/session'

/**
 * MR-153 (созвон 12.08): отключённому пользователю панель РЕАЛЬНО закрыта.
 *
 * Сервер уже отдаёт 403 ACCESS_DISABLED на всё, кроме узкого whitelist (accessGate.js).
 * Здесь — визуальная сторона: поверх панели поп-ап «аккаунт заблокирован, свяжитесь с
 * поддержкой» с blur, а доступны только две страницы — «Поддержка» (узнать/оспорить) и
 * «Мой аккаунт» (продлить/сменить). На них оверлей не показываем — их API в whitelist, и
 * человек должен ими пользоваться. Везде остальном — глухая стена.
 */
const ALLOWED_PATHS = ['/panel/support', '/panel/user/profile']

export function BlockedOverlay() {
  const blocked = useUi((s) => s.accessBlocked)
  const setBlocked = useUi((s) => s.setAccessBlocked)
  const loc = useLocation()
  const navigate = useNavigate()
  const logout = useSession((s) => s.logout)

  // Пока заблокированы — раз в 10 c тихо проверяем /me (он в whitelist): вернул админ доступ
  // → снимаем блок и перезагружаемся с чистого состояния. Без пробника блок висел бы до
  // ручного обновления страницы (accessBlocked сам не снимается). Один запрос в 10 c —
  // не флуд (остальные поллеры при блоке гасит fetchAuth).
  useEffect(() => {
    if (!blocked) return
    const probe = async () => {
      try {
        const r = await fetch('/api/users/me')
        if (r.ok) { setBlocked(''); window.location.reload() }
      } catch { /* сеть — ждём следующей попытки */ }
    }
    const id = window.setInterval(probe, 10_000)
    return () => window.clearInterval(id)
  }, [blocked, setBlocked])

  if (!blocked) return null
  // На разрешённых страницах не мешаем — там человек и должен что-то сделать.
  if (ALLOWED_PATHS.some((p) => loc.pathname.startsWith(p))) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Blur + затемнение всей панели под поп-апом. */}
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-md" />
      <div className="relative w-full max-w-sm rounded-2xl border border-rose-500/30 bg-surface p-7 text-center shadow-2xl">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/15 text-rose-300">
          <Lock size={26} />
        </div>
        <div className="mt-4 font-display text-xl font-bold text-fg">Аккаунт заблокирован</div>
        <p className="mt-2 text-sm text-muted">
          {blocked || 'Доступ отключён.'} Свяжитесь с поддержкой — они подскажут, что делать.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button onClick={() => navigate('/panel/support')} className="btn-primary inline-flex h-11 items-center justify-center gap-2">
            <LifeBuoy size={17} /> Написать в поддержку
          </button>
          <button onClick={() => navigate('/panel/user/profile')} className="btn-ghost inline-flex h-10 items-center justify-center gap-2 border border-line">
            <User size={16} /> Мой аккаунт
          </button>
          <button onClick={logout} className="inline-flex h-9 items-center justify-center gap-1.5 text-sm text-muted hover:text-fg">
            <LogOut size={15} /> Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
