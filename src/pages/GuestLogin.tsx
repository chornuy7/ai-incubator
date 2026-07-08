import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Eye, EyeOff, ArrowRight, ShieldCheck, Bot, Radar, Sparkles } from 'lucide-react'
import { useApp } from '@/mocks/store'

const FEATURES = [
  { icon: Bot, title: 'Нейромодули', desc: 'Комментинг, чаттинг и диалоги на ИИ' },
  { icon: Radar, title: 'Парсеры', desc: 'Каналы, группы, аудитория и комментарии' },
  { icon: Sparkles, title: 'Масс-действия', desc: 'Реакции, просмотры, прогрев аккаунтов' },
  { icon: ShieldCheck, title: 'GGR-рейтинг', desc: 'Проверка качества и здоровья сеток' },
]

export function GuestLogin() {
  const nav = useNavigate()
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const [email, setEmail] = useState('illia@incubator.ai')
  const [pass, setPass] = useState('demo12345')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)

  const login = (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      setUserState('with-data')
      pushToast({ type: 'success', title: 'Добро пожаловать!', desc: 'Вы вошли в демо AI Incubator.' })
      nav('/panel')
    }, 800)
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
            <div className="font-display text-xl font-bold text-fg">AI Incubator</div>
            <div className="text-xs text-muted">Комбайн автоматизации Telegram</div>
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

        <div className="text-xs text-faint">© 2026 AI Incubator · демо-версия</div>
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
            <span className="font-display text-lg font-bold text-fg">AI Incubator</span>
          </div>

          <h2 className="font-display text-2xl font-bold text-fg">Вход в панель</h2>
          <p className="mt-1 text-sm text-muted">Демо-режим — данные подставлены автоматически.</p>

          <form onSubmit={login} className="mt-6 space-y-4">
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
            <div className="flex items-center justify-between text-sm">
              <label className="flex cursor-pointer items-center gap-2 text-muted">
                <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-line accent-spark-500" /> Запомнить
              </label>
              <button type="button" onClick={() => pushToast({ type: 'info', title: 'Восстановление в демо недоступно' })} className="font-semibold text-spark-300 hover:underline">
                Забыли пароль?
              </button>
            </div>
            <button type="submit" disabled={loading} className="btn-primary h-11 w-full">
              {loading ? 'Входим…' : <>Войти в демо <ArrowRight size={17} /></>}
            </button>
          </form>

          <div className="mt-6 rounded-xl border border-line bg-elevated p-3 text-center text-xs text-muted">
            Нажимая «Войти», вы попадаете в сценарий <span className="font-semibold text-fg">«С данными»</span>.
            Переключить сценарии можно в Dev-панели.
          </div>
        </div>
      </div>
    </div>
  )
}
