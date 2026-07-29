import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowRight, ArrowLeft, Check, Zap, CircleCheck } from 'lucide-react'
import { fetchSubscription, type Subscription } from '@/api/balanceApi'
import { getModule, ANNUAL_DISCOUNT, BONUS_MODULE, MODULE_FEATURES } from './catalog'
import { HELP_DOCS } from '@/shared/config/helpDocs'
import { cn } from '@/shared/lib/utils'

/**
 * Страница одного модуля — отдельная ссылка /module/:key (как «Купить X» у
 * конкурентов, но в нашей теме и по нашим ценам). Герой + цена за 30/365 дней +
 * «как это работает». Цена берётся с сервера по ключу модуля.
 */
export function ModuleLandingPage() {
  const { key = '' } = useParams()
  const nav = useNavigate()
  const mod = getModule(key)
  const [pricing, setPricing] = useState<Subscription | null>(null)
  const [periodKey, setPeriodKey] = useState('year') // по умолчанию — выгодный годовой
  useEffect(() => { void fetchSubscription().then(setPricing).catch(() => {}) }, [])

  if (!mod) {
    return (
      <div className="grid min-h-screen place-items-center bg-bg text-fg">
        <div className="text-center">
          <div className="font-display text-xl font-bold">Модуль не найден</div>
          <Link to="/" className="btn-primary mt-4 inline-flex h-10 px-5">На главную</Link>
        </div>
      </div>
    )
  }

  const cur = pricing?.currency || '$'
  const price = pricing?.items.find((i) => i.key === mod.key)?.price ?? 0
  const isBonus = mod.key === BONUS_MODULE.key
  // Периоды подписки — переключаются табом (а не двумя карточками стеком). Массив,
  // чтобы «6 мес» и т.п. добавлялись одной строкой, когда решим скидку по нему.
  // months — длительность, discount — скидка к базовой (месячной) цене за месяц.
  const PERIODS: { key: string; label: string; months: number; days: number; discount: number }[] = [
    { key: 'month', label: 'Месяц', months: 1, days: 30, discount: 0 },
    { key: 'year', label: 'Год', months: 12, days: 365, discount: ANNUAL_DISCOUNT },
    // { key: 'half', label: '6 мес', months: 6, days: 180, discount: 0.10 }, // добавить, когда утвердим скидку
  ]
  const periods = PERIODS.map((p) => {
    const full = price * p.months
    const total = Math.round(full * (1 - p.discount))
    return { ...p, total, perMonth: Math.round(total / p.months), save: full - total }
  })
  const sel = periods.find((p) => p.key === periodKey) ?? periods[0]
  const Icon = mod.icon
  const start = () => nav('/login')
  // §10.7: подтягиваем глубокую доку модуля (тот же источник, что «Обучение») —
  // страница была бедной: только «как работает» + цена. Теперь пример, связка,
  // риски и советы, если они есть для этого модуля.
  const doc = HELP_DOCS[mod.key]

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-spark-gradient text-[#04150c]">
              <Zap size={18} fill="currentColor" />
            </div>
            <div className="font-display text-sm font-bold leading-tight">Murmex</div>
          </Link>
          <Link to="/#tarify" className="btn-ghost ml-auto h-9 px-4 text-sm"><ArrowLeft size={15} /> Все тарифы</Link>
          <button onClick={start} className="btn-primary h-9 px-4 text-sm">Войти <ArrowRight size={15} /></button>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-10 px-5 py-14 lg:grid-cols-[1.3fr_1fr] lg:py-20">
        {/* Левая — что это */}
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-spark-500/30 bg-spark-500/10 px-3 py-1 text-xs font-semibold text-spark-200">
            <span className="h-1.5 w-1.5 rounded-full bg-spark-400" /> Модуль работает 24/7
          </span>
          <div className="mt-5 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-spark-500/12 text-spark-300"><Icon size={24} /></div>
            <h1 className="font-display text-3xl font-bold sm:text-4xl">{mod.title}</h1>
          </div>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">{mod.description}</p>

          <div className="mt-8 rounded-2xl border border-line bg-card p-5">
            <div className="mb-3 text-sm font-semibold text-fg">Как это работает</div>
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {mod.how.map((h) => (
                <li key={h} className="flex items-start gap-2 text-sm text-muted">
                  <CircleCheck size={16} className="mt-0.5 shrink-0 text-spark-400" /> {h}
                </li>
              ))}
            </ul>
          </div>

          {!!MODULE_FEATURES[mod.key]?.length && (
            <div className="mt-4 rounded-2xl border border-line bg-card p-5">
              <div className="mb-3 text-sm font-semibold text-fg">Возможности модуля</div>
              <ul className="grid gap-2.5 sm:grid-cols-2">
                {MODULE_FEATURES[mod.key].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-muted">
                    <Check size={16} className="mt-0.5 shrink-0 text-spark-400" /> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {doc?.example && (
            <div className="mt-4 rounded-2xl border border-spark-500/25 bg-spark-500/6 p-5">
              <div className="mb-2 text-sm font-semibold text-fg">Пример</div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{doc.example}</p>
            </div>
          )}

          {doc?.together && (
            <div className="mt-4 rounded-2xl border border-line bg-card p-5">
              <div className="mb-2 text-sm font-semibold text-fg">Работает в связке</div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{doc.together}</p>
            </div>
          )}

          {doc?.risks && (
            <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/[.06] p-5">
              <div className="mb-2 text-sm font-semibold text-amber-300">Риски и безопасность</div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-amber-100/80">{doc.risks}</p>
            </div>
          )}

          {!!doc?.tips?.length && (
            <div className="mt-4 rounded-2xl border border-line bg-card p-5">
              <div className="mb-2 text-sm font-semibold text-fg">Советы</div>
              <ul className="space-y-1.5">
                {doc.tips.map((t) => (
                  <li key={t} className="flex gap-2 text-sm text-muted"><span className="text-spark-400">•</span> {t}</li>
                ))}
              </ul>
            </div>
          )}

          {mod.unique && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-xl border border-iris-500/25 bg-iris-500/10 px-3 py-2 text-sm text-iris-200">
              <Sparkle /> Есть у нас — редко у кого из конкурентов
            </div>
          )}
        </div>

        {/* Правая — цена */}
        <div className="lg:pt-2">
          {isBonus ? (
            <div className="rounded-2xl border border-spark-500/40 bg-spark-500/8 p-6">
              <div className="text-sm font-semibold text-spark-300">В подарок</div>
              <div className="mt-1 font-display text-3xl font-bold">Бесплатно</div>
              <p className="mt-2 text-sm text-muted">Идёт с любым набором модулей.</p>
              <button onClick={start} className="btn-primary mt-5 h-11 w-full">Начать <ArrowRight size={17} /></button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Переключатель периода — таб вместо двух карточек стеком. */}
              <div className="inline-flex w-full rounded-xl border border-line bg-card p-1">
                {periods.map((p) => (
                  <button key={p.key} onClick={() => setPeriodKey(p.key)}
                    className={cn(
                      'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                      periodKey === p.key ? 'bg-spark-500/20 text-spark-200' : 'text-muted hover:text-fg',
                    )}>
                    {p.label}
                    {p.discount > 0 && <span className="ml-1 text-[10px] text-spark-300">−{Math.round(p.discount * 100)}%</span>}
                  </button>
                ))}
              </div>

              {/* Одна карта — обновляется по выбранному периоду. */}
              <div className={cn('rounded-2xl border p-5', sel.save > 0 ? 'border-spark-500/40 bg-spark-500/8' : 'border-line bg-card')}>
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
                  {sel.days} дней
                  {sel.save > 0 && <span className="rounded-md bg-spark-500/20 px-1.5 py-0.5 text-[10px] text-spark-300">выгода {Math.round(sel.discount * 100)}%</span>}
                </div>
                <div className="mt-1 font-display text-3xl font-bold">{cur}{sel.total}</div>
                <div className="mt-1 text-sm text-muted">
                  {sel.months > 1
                    ? <>≈ {cur}{sel.perMonth} / месяц · экономия {cur}{sel.save}</>
                    : <>{cur}{sel.perMonth} / месяц</>}
                </div>
                <button onClick={start} className="btn-primary mt-4 h-11 w-full">Выбрать <ArrowRight size={16} /></button>
              </div>

              <div className="flex items-center gap-2 px-1 text-xs text-muted">
                <Check size={14} className="text-spark-400" /> Доступ сразу · обновления без доплат · работа ИИ оплачивается монетами
              </div>
            </div>
          )}
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-5 py-8 text-xs text-muted">
        <Link to="/" className="hover:text-fg">← Murmex — все модули и тарифы</Link>
      </footer>
    </div>
  )
}

function Sparkle() {
  return <span className="text-iris-300">★</span>
}
