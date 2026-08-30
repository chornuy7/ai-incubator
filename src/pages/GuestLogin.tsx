import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
  // С лендинга приходим с ?mode=register&plan=<модуль>: сразу открываем регистрацию, а
  // после успеха ведём на подписку с выбранным модулем (доступ включается там же).
  const [params] = useSearchParams()
  const planKey = params.get('plan') || ''
  const [mode, setMode] = useState<'login' | 'register'>(params.get('mode') === 'register' ? 'register' : 'login')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('') // §5.1: повтор пароля
  const [name, setName] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  // §5.1 (AUTH-001): ошибки валидации/API показываем в форме, а не только в тосте/консоли.
  const [errors, setErrors] = useState<{ name?: string; email?: string; pass?: string; pass2?: string; form?: string }>({})
  const isReg = mode === 'register'

  // §5.1 (AUTH-001): клиентская валидация. Полное имя ≥4, корректный e-mail, пароль ≥6, повтор совпадает.
  const validate = () => {
    const e: typeof errors = {}
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = 'Введите корректный e-mail.'
    if (!pass) e.pass = 'Введите пароль.'
    if (isReg) {
      // §5.1/§24.1 (AUTH-001): полное имя ≥4; разрешены буквы любого языка, пробел, дефис,
      // апостроф и точка (вариант A по решению заказчика). Цифры/@/эмодзи/спецсимволы — нет.
      if (name.trim().length < 4) e.name = 'Полное имя — минимум 4 символа.'
      else if (!/^[\p{L} '’.-]+$/u.test(name.trim())) e.name = 'Имя: только буквы, пробел, дефис, апостроф и точка.'
      if (pass && pass.length < 6) e.pass = 'Пароль — минимум 6 символов.'
      if (pass !== pass2) e.pass2 = 'Пароли не совпадают.'
    }
    return e
  }
  // §10.2: капча на регистрации — показываем виджет только если она включена на сервере.
  const [captcha, setCaptcha] = useState<{ enabled: boolean; siteKey: string }>({ enabled: false, siteKey: '' })
  const [captchaToken, setCaptchaToken] = useState('')
  /*
   * Сбой этого запроса раньше глотался молча, и именно поэтому баг 30.08 был невидим:
   * сервер отвечал гостю 401, фронт решал, что капчи нет, виджет не рисовался, а человек
   * получал «проверка «я не робот» не пройдена» и не имел ни одного намёка на причину.
   * Ответа нет — говорим об этом вслух, а не делаем вид, что капчи не существует.
   */
  useEffect(() => {
    void fetchAuthConfig()
      .then((c) => setCaptcha(c.captcha))
      .catch((e) => console.warn('[регистрация] не удалось узнать настройки капчи:', e))
  }, [])
  const needCaptcha = isReg && captcha.enabled

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // §5.1 (AUTH-001): сначала клиентская валидация — ошибки показываем под полями.
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length) return
    if (needCaptcha && !captchaToken) {
      pushToast({ type: 'error', title: 'Подтвердите, что вы не робот', desc: 'Пройдите проверку ниже.' })
      return
    }
    setLoading(true)
    try {
      const { user, role, isOwner } = isReg
        ? await registerUser(email.trim(), pass, name.trim(), captchaToken)
        : await loginUser(email.trim(), pass)
      signIn(user, role && role.permissions ? { id: role.id, name: role.name, permissions: role.permissions } : null, isOwner)
      setUserState('with-data')
      pushToast({
        type: 'success',
        title: isReg ? `Аккаунт создан, ${user.name}!` : `Добро пожаловать, ${user.name}!`,
        desc: planKey ? 'Подтвердите подписку — доступ включится сразу.' : (isReg ? 'Доступ к модулям выдаст администратор.' : (role?.name ? `Роль: ${role.name}` : 'Вход выполнен.')),
      })
      // Пришёл с лендинга с выбранным модулем → на страницу подписки с предвыбором, иначе — в кабинет.
      // MR-142 (баг 1): жёсткая навигация (не SPA) = чистый boot без данных прошлого юзера.
      // Раньше nav() оставлял в памяти модульные кэши/сторы прошлой сессии — «тянулись старые
      // данные прошлой БД». Сессия уже в localStorage, после перезагрузки подхватится.
      const dest = planKey ? `/panel/user/subscription?apply=${encodeURIComponent(planKey)}` : '/panel'
      try { window.location.assign(dest) } catch { nav(dest) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Проверьте данные'
      // §5.1: понятное сообщение о существующем аккаунте вместо сырой ошибки Supabase/API.
      const isDup = isReg && /exist|already|registered|duplicate|занят|уже|taken/i.test(msg)
      const friendly = isDup ? 'Аккаунт с таким e-mail уже существует. Войдите или используйте другой e-mail.' : msg
      // §5.1: ошибка видна В ФОРМЕ (не только в тосте/консоли).
      setErrors(isDup ? { email: friendly } : { form: friendly })
      pushToast({
        type: 'error',
        title: isReg ? 'Не удалось зарегистрироваться' : 'Не удалось войти',
        desc: friendly,
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

          {/*
            §5.1 (AUTH-001): убираем автозаполнение. Одного `autoComplete="off"` мало —
            Chrome его игнорирует, когда поле «похоже на e-mail» (по подписи и
            placeholder) и есть сохранённые данные. Поэтому три приёма разом:
              1) поля-приманки в начале формы — на них уходит автоподстановка браузера;
              2) нестандартный токен autoComplete на регистрации: браузер не узнаёт тип
                 поля и не предлагает сохранённые адреса/пароли;
              3) data-1p-ignore / data-lpignore — то же для 1Password и LastPass.
            На ВХОДЕ автозаполнение оставляем: там оно людям помогает.
          */}
          <form onSubmit={submit} autoComplete="off" className="mt-6 space-y-4">
            {isReg && (
              <div aria-hidden className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0">
                <input type="text" tabIndex={-1} autoComplete="username" />
                <input type="password" tabIndex={-1} autoComplete="current-password" />
              </div>
            )}
            {isReg && (
              <div>
                <label className="label">Полное имя</label>
                <input value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })) }} autoComplete="off" data-1p-ignore data-lpignore="true" className={`input ${errors.name ? 'border-rose-500/60' : ''}`} placeholder="Имя и фамилия (минимум 4 символа)" />
                {errors.name && <p className="mt-1 text-xs text-rose-400">{errors.name}</p>}
              </div>
            )}
            <div>
              <label className="label">E-mail</label>
              <input
                value={email}
                onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined, form: undefined })) }}
                autoComplete={isReg ? 'murmex-no-autofill' : 'username'}
                data-1p-ignore={isReg || undefined}
                data-lpignore={isReg ? 'true' : undefined}
                className={`input ${errors.email ? 'border-rose-500/60' : ''}`}
                placeholder="you@example.com"
              />
              {errors.email && <p className="mt-1 text-xs text-rose-400">{errors.email}</p>}
            </div>
            <div>
              <label className="label">Пароль</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => { setPass(e.target.value); setErrors((x) => ({ ...x, pass: undefined })) }}
                  autoComplete={isReg ? 'new-password' : 'current-password'}
                  data-1p-ignore={isReg || undefined}
                  data-lpignore={isReg ? 'true' : undefined}
                  className={`input pr-11 ${errors.pass ? 'border-rose-500/60' : ''}`}
                  placeholder={isReg ? 'Минимум 6 символов' : '••••••••'}
                />
                <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {errors.pass && <p className="mt-1 text-xs text-rose-400">{errors.pass}</p>}
            </div>
            {isReg && (
              <div>
                <label className="label">Повтор пароля</label>
                <input type={show ? 'text' : 'password'} value={pass2} onChange={(e) => { setPass2(e.target.value); setErrors((x) => ({ ...x, pass2: undefined })) }} autoComplete="new-password" data-1p-ignore data-lpignore="true" className={`input ${errors.pass2 ? 'border-rose-500/60' : ''}`} placeholder="Повторите пароль" />
                {errors.pass2 && <p className="mt-1 text-xs text-rose-400">{errors.pass2}</p>}
              </div>
            )}
            {errors.form && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{errors.form}</div>
            )}
            {/* §10.2: капча — только на регистрации и только если включена на сервере. */}
            {needCaptcha && <Turnstile siteKey={captcha.siteKey} onToken={setCaptchaToken} />}
            <button type="submit" disabled={loading || (needCaptcha && !captchaToken)} className="btn-primary h-11 w-full disabled:opacity-50">
              {loading ? (isReg ? 'Создаём…' : 'Входим…') : (isReg ? <>Зарегистрироваться <ArrowRight size={17} /></> : <>Войти <ArrowRight size={17} /></>)}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-muted">
            {isReg ? (
              <>Уже есть аккаунт?{' '}
                <button type="button" onClick={() => { setMode('login'); setErrors({}) }} className="font-semibold text-spark-300 hover:underline">Войти</button>
              </>
            ) : (
              <>Нет аккаунта?{' '}
                <button type="button" onClick={() => { setMode('register'); setErrors({}) }} className="font-semibold text-spark-300 hover:underline">Зарегистрироваться</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
