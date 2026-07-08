import { useEffect, useMemo, useState } from 'react'
import { Phone, KeyRound, ShieldCheck, CheckCircle2, Loader2, Server } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { COUNTRIES } from '@/shared/config/countries'
import { sendCode, verifyCode, verify2fa, type TgAccountPayload } from '@/api/tgAuth'
import { cn } from '@/shared/lib/utils'
import type { TgAccount } from '@/shared/types'

type Step = 'phone' | 'code' | '2fa' | 'done'
type WizardMode = 'add' | 'reauth'

const STEP_INDEX: Record<Step, number> = { phone: 0, code: 1, '2fa': 2, done: 3 }
const STEPS = ['Номер', 'Код', '2FA', 'Готово']

function proxyToUrl(p: { type: string; host: string; port: number; login?: string }) {
  const auth = p.login ? `${p.login}@` : ''
  return `${p.type}://${auth}${p.host}:${p.port}`
}

function parsePhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  const match = COUNTRIES.find((c) => digits.startsWith(c.dial.replace('+', '')))
  if (match) {
    return {
      country: match.code,
      local: digits.slice(match.dial.replace('+', '').length),
    }
  }
  return { country: 'ua', local: digits }
}

export function AddAccountWizard({
  open,
  onClose,
  mode = 'add',
  account = null,
}: {
  open: boolean
  onClose: () => void
  mode?: WizardMode
  account?: TgAccount | null
}) {
  const proxies = useApp((s) => s.data.proxies)
  const loadAccounts = useApp((s) => s.loadAccounts)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [step, setStep] = useState<Step>('phone')
  const [country, setCountry] = useState('ua')
  const [phone, setPhone] = useState('')
  const [proxy, setProxy] = useState('')
  const [proxyMode, setProxyMode] = useState<'none' | 'pool' | 'manual'>('none')
  const [code, setCode] = useState('')
  const [pass, setPass] = useState('')
  const [authId, setAuthId] = useState('')
  const [codeViaApp, setCodeViaApp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const isReauth = mode === 'reauth' && !!account
  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? '+'
  const fullPhone = `${dial}${phone.replace(/\D/g, '')}`

  const poolOptions = useMemo(
    () =>
      proxies
        .filter((p) => p.status === 'ok')
        .map((p) => ({
          value: proxyToUrl(p),
          label: `${proxyToUrl(p)} · ${p.usedBy} акк.`,
        })),
    [proxies],
  )

  const resolvedProxy = proxyMode === 'none' ? undefined : proxy.trim() || undefined

  const reset = () => {
    setStep('phone')
    setPhone('')
    setProxy('')
    setProxyMode('none')
    setCode('')
    setPass('')
    setAuthId('')
    setCodeViaApp(false)
    setError('')
    setLoading(false)
  }

  const close = () => {
    reset()
    onClose()
  }

  useEffect(() => {
    if (!open) return
    reset()
    if (isReauth && account) {
      const parsed = parsePhone(account.phone)
      setCountry(parsed.country)
      setPhone(parsed.local)
      const hasProxy = account.proxy && account.proxy !== '—'
      if (!hasProxy) {
        setProxyMode('none')
        setProxy('')
      } else if (poolOptions.some((o) => o.value === account.proxy)) {
        setProxyMode('pool')
        setProxy(account.proxy)
      } else {
        setProxyMode('manual')
        setProxy(account.proxy)
      }
    } else {
      setProxyMode('none')
      setProxy('')
    }
  }, [open, isReauth, account?.id])

  const submitPhone = async () => {
    setError('')
    if (phone.replace(/\D/g, '').length < 6) return setError('Введите корректный номер телефона')
    if (proxyMode !== 'none' && !proxy.trim()) return setError('Укажите прокси или выберите «Без прокси»')
    if (!guardNet('отправка кода')) return
    setLoading(true)
    try {
      const res = await sendCode(
        fullPhone,
        resolvedProxy,
        isReauth ? account?.tgSessionId || account?.id : undefined,
      )
      setAuthId(res.authId)
      setCodeViaApp(res.isCodeViaApp)
      setStep('code')
      pushToast({
        type: 'info',
        title: res.isCodeViaApp ? 'Код в Telegram' : 'Код отправлен',
        desc: res.isCodeViaApp
          ? 'Проверьте чат «Telegram» — код придёт в приложение.'
          : `SMS отправлена на ${fullPhone}`,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить код')
    } finally {
      setLoading(false)
    }
  }

  const submitCode = async () => {
    setError('')
    if (!authId) return setError('Сессия истекла — начните сначала')
    const digits = code.replace(/\D/g, '')
    if (digits.length !== 5) return setError('Код — 5 цифр из SMS или Telegram')
    if (!guardNet('проверка кода')) return
    setLoading(true)
    try {
      const res = await verifyCode(authId, digits)
      if (res.needs2fa) {
        setStep('2fa')
      } else if (res.account) {
        finishWithAccount(res.account)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Неверный код')
    } finally {
      setLoading(false)
    }
  }

  const submit2fa = async () => {
    setError('')
    if (!authId) return setError('Сессия истекла — начните сначала')
    if (!guardNet('проверка пароля')) return
    setLoading(true)
    try {
      const res = await verify2fa(authId, pass)
      finishWithAccount(res.account)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Неверный пароль')
    } finally {
      setLoading(false)
    }
  }

  const finishWithAccount = (payload: TgAccountPayload) => {
    void loadAccounts()
    pushToast({
      type: 'success',
      title: isReauth ? 'Аккаунт авторизован' : 'Аккаунт добавлен',
      desc: payload.name,
    })
    setStep('done')
  }

  const title = isReauth ? 'Реавторизация' : 'Добавить аккаунт'
  const subtitle = isReauth
    ? `${account?.name} · повторный вход в Telegram`
    : 'Авторизация Telegram по номеру телефона'

  return (
    <Modal open={open} onClose={close} title={title} subtitle={subtitle} icon={<Phone size={22} />} size="md">
      <div className="mb-6 flex items-center">
        {STEPS.map((s, i) => (
          <div key={s} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-full text-xs font-bold transition-colors',
                  i < STEP_INDEX[step]
                    ? 'bg-spark-500 text-[#04150c]'
                    : i === STEP_INDEX[step]
                      ? 'bg-spark-gradient text-[#04150c] ring-4 ring-spark-500/20'
                      : 'border border-line bg-elevated text-muted',
                )}
              >
                {i < STEP_INDEX[step] ? <CheckCircle2 size={16} /> : i + 1}
              </div>
              <span className={cn('text-[11px] font-semibold', i <= STEP_INDEX[step] ? 'text-fg' : 'text-faint')}>
                {s}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn('mx-2 h-0.5 flex-1 rounded', i < STEP_INDEX[step] ? 'bg-spark-500' : 'bg-line')} />
            )}
          </div>
        ))}
      </div>

      {step === 'phone' && (
        <div className="space-y-4">
          {isReauth && (
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 p-3 text-sm text-fg">
              Сессия истекла. Подтвердите номер и пройдите вход заново.
            </div>
          )}
          <div>
            <label className="label">Страна</label>
            {isReauth ? (
              <div className="input flex items-center gap-2 opacity-80">
                {COUNTRIES.find((c) => c.code === country)?.flag}{' '}
                {COUNTRIES.find((c) => c.code === country)?.label}
                <span className="text-muted">{dial}</span>
              </div>
            ) : (
              <Select
                value={country}
                onChange={setCountry}
                options={COUNTRIES.map((c) => ({
                  value: c.code,
                  label: (
                    <span>
                      {c.flag} {c.label} <span className="text-muted">{c.dial}</span>
                    </span>
                  ),
                }))}
              />
            )}
          </div>
          <div>
            <label className="label">Номер телефона</label>
            <div className="flex gap-2">
              <div className="grid w-20 place-items-center rounded-xl border border-line bg-elevated text-sm font-bold text-fg">
                {dial}
              </div>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={isReauth}
                className="input flex-1 disabled:opacity-60"
                placeholder="66 929 50 84"
                inputMode="numeric"
              />
            </div>
          </div>
          <div>
            <label className="label">Прокси</label>
            <div className="mb-2 inline-flex flex-wrap gap-1 rounded-lg border border-line bg-elevated p-0.5">
              <button
                type="button"
                onClick={() => { setProxyMode('none'); setProxy('') }}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-semibold',
                  proxyMode === 'none' ? 'bg-spark-gradient text-[#04150c]' : 'text-muted',
                )}
              >
                Без прокси
              </button>
              {poolOptions.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setProxyMode('pool'); setProxy(poolOptions[0]?.value ?? '') }}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs font-semibold',
                    proxyMode === 'pool' ? 'bg-spark-gradient text-[#04150c]' : 'text-muted',
                  )}
                >
                  Из пула
                </button>
              )}
              <button
                type="button"
                onClick={() => setProxyMode('manual')}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-semibold',
                  proxyMode === 'manual' ? 'bg-spark-gradient text-[#04150c]' : 'text-muted',
                )}
              >
                Вручную
              </button>
            </div>
            {proxyMode === 'pool' && poolOptions.length > 0 ? (
              <Select value={proxy} onChange={setProxy} options={poolOptions} />
            ) : proxyMode === 'manual' ? (
              <div className="relative">
                <Server size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  className="input pl-9"
                  placeholder="socks5://user:pass@host:port"
                />
              </div>
            ) : (
              <div className="rounded-xl border border-line bg-elevated px-3 py-2.5 text-sm text-muted">
                Прямое подключение к Telegram (IP вашего сервера / ПК).
              </div>
            )}
            <p className="mt-1 text-xs text-muted">
              Прокси опционален. Для нескольких аккаунтов рекомендуется отдельный SOCKS5 на каждый.
            </p>
          </div>
          {error && <p className="text-sm font-medium text-rose-400">{error}</p>}
          <button onClick={submitPhone} disabled={loading} className="btn-primary h-11 w-full">
            {loading ? <Loader2 size={17} className="animate-spin" /> : 'Отправить код'}
          </button>
        </div>
      )}

      {step === 'code' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-elevated p-3 text-sm text-muted">
            {codeViaApp ? (
              <>
                Код отправлен в приложение <span className="font-bold text-fg">Telegram</span> для номера{' '}
                <span className="font-bold text-fg">{fullPhone}</span>
              </>
            ) : (
              <>
                SMS-код отправлен на <span className="font-bold text-fg">{fullPhone}</span>
              </>
            )}
          </div>
          <div>
            <label className="label">Код из SMS / Telegram</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              className="input text-center font-mono text-lg tracking-[0.5em]"
              placeholder="12345"
              maxLength={5}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            <p className="mt-1 text-center text-xs text-muted">5 цифр</p>
          </div>
          {error && <p className="text-sm font-medium text-rose-400">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setStep('phone')} className="btn-ghost h-11 flex-1">
              Назад
            </button>
            <button onClick={submitCode} disabled={loading} className="btn-primary h-11 flex-[2]">
              {loading ? <Loader2 size={17} className="animate-spin" /> : 'Подтвердить код'}
            </button>
          </div>
        </div>
      )}

      {step === '2fa' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2.5 rounded-xl border border-iris-500/30 bg-iris-500/8 p-3 text-sm text-fg">
            <ShieldCheck size={18} className="text-iris-300" /> На аккаунте включена двухфакторная аутентификация.
          </div>
          <div>
            <label className="label">Облачный пароль (2FA)</label>
            <div className="relative">
              <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                className="input pl-9"
                placeholder="Облачный пароль Telegram"
              />
            </div>
          </div>
          {error && <p className="text-sm font-medium text-rose-400">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setStep('code')} className="btn-ghost h-11 flex-1">
              Назад
            </button>
            <button onClick={submit2fa} disabled={loading} className="btn-primary h-11 flex-[2]">
              {loading ? <Loader2 size={17} className="animate-spin" /> : 'Войти'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-spark-500/12 text-spark-400 animate-pulse-ring">
            <CheckCircle2 size={34} />
          </div>
          <div>
            <div className="font-display text-lg font-bold text-fg">
              {isReauth ? 'Сессия восстановлена' : 'Аккаунт добавлен'}
            </div>
            <div className="text-sm text-muted">
              {fullPhone} — статус «Активные», строка обновлена в таблице.
            </div>
          </div>
          <div className="flex w-full gap-2 pt-2">
            {!isReauth && (
              <button onClick={() => reset()} className="btn-ghost h-11 flex-1">
                Добавить ещё
              </button>
            )}
            <button onClick={close} className={cn('btn-primary h-11', isReauth ? 'w-full' : 'flex-1')}>
              Готово
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
