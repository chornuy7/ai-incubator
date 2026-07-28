import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Zap, Eye, EyeOff, ArrowRight, LogOut, ShieldAlert } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { loginUser } from '@/api/usersApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { AdminStatsPage } from '@/pages/AdminStatsPage'
import { Toasts } from '@/widgets/Toasts'
import { DialogHost } from '@/widgets/DialogHost'

/**
 * §5.3: Админ-панель ОТДЕЛЬНОЙ ссылкой (/admin) с ОТДЕЛЬНЫМ входом.
 *
 * Заказчик: «адмін панель повинна бути по окремій силці і мати окремий доступ».
 * Поэтому это не пункт сайдбара панели, а самостоятельная страница со своей формой
 * входа: сюда пускает только пользователь с ролью админа (bypass). Обычный оператор,
 * даже с верным паролем, получает отказ — здесь данные по всем деньгам и людям.
 */
function isAdminUser(u: { roleId?: string; roleIds?: string[] } | null | undefined): boolean {
  if (!u) return false
  return u.roleId === ADMIN_BYPASS_ID || (u.roleIds || []).includes(ADMIN_BYPASS_ID)
}

export function AdminEntry() {
  const sessionUser = useSession((s) => s.user)
  if (sessionUser?.isAdmin) return <AdminShell />
  return <AdminLogin />
}

/** Полноэкранная админка со своей шапкой — без сайдбара панели. */
function AdminShell() {
  const sessionUser = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* §10.1: в sudo-админке ленту/модалку низкого баланса НЕ показываем — это пульт
          управления системой, а не кабинет клиента; владельца незачем пушить платить. */}
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-5 py-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/15 text-iris-300">
            <Zap size={18} fill="currentColor" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-sm font-bold leading-tight">AI Incubator · Админ-панель</div>
            <div className="truncate text-[11px] leading-tight text-muted">{sessionUser?.email}</div>
          </div>
          <Link to="/panel" className="btn-ghost ml-auto h-9 px-3 text-sm">В панель</Link>
          <button onClick={logout} className="btn-ghost h-9 px-3 text-sm" title="Выйти из админки">
            <LogOut size={15} /> Выйти
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <AdminStatsPage />
      </main>

      <Toasts />
      <DialogHost />
    </div>
  )
}

/** Отдельный вход в админку. Пускает только админа. */
function AdminLogin() {
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const signIn = useSession((s) => s.login)
  const logout = useSession((s) => s.logout)
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const { user, role } = await loginUser(email.trim(), pass)
      if (!isAdminUser(user)) {
        // Не админ — доступ закрыт: сессию не поднимаем, чтобы обычный оператор не
        // остался «наполовину вошедшим» в закрытый ему раздел.
        logout()
        setError('Доступ только для администратора.')
        return
      }
      signIn(user, role && role.permissions ? { id: role.id, name: role.name, permissions: role.permissions } : null)
      setUserState('with-data')
      pushToast({ type: 'success', title: `Админ-панель · ${user.name}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Проверьте e-mail и пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6 text-fg">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-iris-500/15 text-iris-300">
            <Zap size={22} fill="currentColor" />
          </div>
          <div>
            <div className="font-display text-lg font-bold">Админ-панель</div>
            <div className="text-xs text-muted">Отдельный вход · только для администратора</div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-card p-6">
          <div>
            <label className="label">E-mail администратора</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="admin@example.com" autoFocus />
          </div>
          <div>
            <label className="label">Пароль</label>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                className="input pr-11"
                placeholder="••••••••"
              />
              <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2 text-sm text-red-300">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary h-11 w-full">
            {loading ? 'Входим…' : <>Войти в админку <ArrowRight size={17} /></>}
          </button>
        </form>

        <div className="mt-4 text-center">
          <Link to="/panel" className="text-xs text-muted hover:text-fg">← Обычная панель</Link>
        </div>
      </div>
    </div>
  )
}
