import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Eye, EyeOff, ArrowRight, ShieldCheck, Bot, Radar, Sparkles } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { loginUser, registerUser, fetchAuthConfig } from '@/api/usersApi'
import { Turnstile } from '@/features/auth/Turnstile'

const FEATURES = [
  { icon: Bot, title: 'Нейромодули', desc: 'Комментинг, чаттинг и диалоги на ИИ' },
  { icon: Radar, title: 'Парсеры', desc: 'Каналы, группы, аудитория и комментарии' },
  { icon: Sparkles, title: 'Масс-действия', desc: 'Реакции, просмотры, прогрев аккаунтов' },
  { icon: ShieldCheck, title: 'AIR — AI Rating', desc: 'Проверка качества и здоровья сеток' },
]

export function GuestLogin() {
  const nav = useNavigate()
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const signIn = useSession((s) => s.login)
  // Регистрация с лендинга: тестер заводит аккаунт сам, доступ к модулям выдаёт админ.
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [name, setName] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const isReg = mode === 'register'
  // §10.2: капча на регистрации — показываем виджет только если она включена на сервере.
  const [captcha, setCaptcha] = useState<{ enabled: boolean; siteKey: string }>({ enabled: false, siteKey: '' })
  const [captchaToken, setCaptchaToken] = useState('')
  useEffect(() => { void fetchAuthConfig().then((c) => setCaptcha(c.captcha)).catch(() => {}) }, [])
  const needCaptcha = isReg && captcha.enabled

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (needCaptcha && !captchaToken) {
      pushToast({ type: 'error', title: 'Подтвердите, что вы не робот', desc: 'Пройдите проверку ниже.' })
      return
    }
    setLoading(true)
    try {
      const { user, role } = isReg
        ? await registerUser(email.trim(), pass, name.trim(), captchaToken)
        : await loginUser(email.trim(), pass)
      signIn(user, role && role.permissions ? { id: role.id, name: role.name, permissions: role.permissions } : null)
      setUserState('with-data')
      pushToast({
        type: 'success',
        title: isReg ? `Аккаунт создан, ${user.name}!` : `Добро пожаловать, ${user.name}!`,
        desc: isReg ? 'Доступ к модулям выдаст администратор.' : (role?.name ? `Роль: ${role.name}` : 'Вход выполнен.'),
      })
      nav('/panel')
    } catch (err) {
      pushToast({
        type: 'error',
        title: isReg ? 'Не удалось зарегистрироваться' : 'Не удалось войти',
        desc: err instanceof Error ? err.message : 'Проверьте данные',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left — brand */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface p-10 lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-spark-gradient shadow-[0_4px_20px_-4px_rgba(14,196,100,0.6)]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3c3.6 0 6.2 3.7 6.2 7.8 0 3.4-2.8 6.2-6.2 6.2s-6.2-2.8-6.2-6.2C5.8 6.7 8.4 3 12 3Z" stroke="#04150c" strokeWidth="1.8" />
              <path d="M9.4 11l1.9 2.4L15 8.6" stroke="#04150c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="font-display text-xl font-bold text-fg">Murmex</div>
            <div className="text-xs text-muted">Платформа автоматизации Telegram</div>
          </div>
        </div>

        <div className="relative z-10">
          <h1 className="font-display text-4xl font-bold leading-tight text-fg">
            Выращивайте <span className="text-gradient">сети аккаунтов</span> на автопилоте
          </h1>
          <p className="mt-4 max-w-md text-muted">
            Менеджер аккаунтов, нейромодули и парсеры в одной панели. Полностью на мок-данных — исследуйте интерфейс без риска.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-elevated p-4">
                <f.icon size={20} className="text-spark-400" />
                <div className="mt-2 text-sm font-bold text-fg">{f.title}</div>
                <div className="text-xs text-muted">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="text-xs text-faint">© 2026 Murmex · демо-версия</div>
        <div className="pointer-events-none absolute -right-20 -top-20 h-80 w-80 rounded-full bg-spark-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-10 h-72 w-72 rounded-full bg-iris-500/20 blur-3xl" />
      </div>

      {/* Right — form */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-spark-gradient">
              <Zap size={20} className="text-[#04150c]" fill="currentColor" />
            </div>
            <span className="font-display text-lg font-bold text-fg">Murmex</span>
          </div>

          <h2 className="font-display text-2xl font-bold text-fg">{isReg ? 'Регистрация' : 'Вход в панель'}</h2>
          <p className="mt-1 text-sm text-muted">
            {isReg ? 'Заведите аккаунт — доступ к модулям выдаст администратор.' : 'Войдите под своей учётной записью.'}
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {isReg && (
              <div>
                <label className="label">Имя</label>
                <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Как к вам обращаться" />
              </div>
            )}
            <div>
              <label className="label">E-mail</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="you@example.com" />
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
            {/* §10.2: капча — только на регистрации и только если включена на сервере. */}
            {needCaptcha && <Turnstile siteKey={captcha.siteKey} onToken={setCaptchaToken} />}
            <button type="submit" disabled={loading || (needCaptcha && !captchaToken)} className="btn-primary h-11 w-full disabled:opacity-50">
              {loading ? (isReg ? 'Создаём…' : 'Входим…') : (isReg ? <>Зарегистрироваться <ArrowRight size={17} /></> : <>Войти <ArrowRight size={17} /></>)}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-muted">
            {isReg ? (
              <>Уже есть аккаунт?{' '}
                <button type="button" onClick={() => setMode('login')} className="font-semibold text-spark-300 hover:underline">Войти</button>
              </>
            ) : (
              <>Нет аккаунта?{' '}
                <button type="button" onClick={() => setMode('register')} className="font-semibold text-spark-300 hover:underline">Зарегистрироваться</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
