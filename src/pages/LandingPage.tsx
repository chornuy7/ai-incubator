import { useState, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  ArrowRight, Check, Zap, Lock, Minus, X, Quote, TrendingUp, Clock, Bot, Star,
  Coins, ShoppingBag, Clapperboard, Building2, Rocket, type LucideIcon,
} from 'lucide-react'

/** §10.6: иконка кейса по отрасли — узнаётся по ключевому слову в названии. */
function caseIcon(title: string): LucideIcon {
  const t = title.toLowerCase()
  if (t.includes('крипт')) return Coins
  if (t.includes('магаз')) return ShoppingBag
  if (t.includes('креатор') || t.includes('контент')) return Clapperboard
  if (t.includes('агентств')) return Building2
  return Rocket
}
import { fetchSubscription, quoteSubscription, type Subscription, type SubCost } from '@/api/balanceApi'
import { MODULES, BONUS_MODULE, FUNNEL_STEPS, COMPARISON, REVIEWS, CASES, ANNUAL_DISCOUNT, moduleTagline, moduleIcon, type Cmp } from './landing/catalog'

/**
 * B1 (SPEC §5.2): публичный лендинг — единственная страница вне auth-гейта.
 *
 * Структура в духе современных лендингов (герой → как работает → модули → цены →
 * сравнение → отзывы → кейсы), но НА НАШИХ данных: наши модули, наши цены с сервера,
 * наши уникальные фичи (цели/CRM, умный прогрев, AIR). Не копия — адаптация.
 */
/**
 * §10.6: два позиционирования одного продукта, переключаемые GET-параметром `?v=`.
 * Для SEO/маркетинга: одна и та же платформа под разные кампании — «all-in-one
 * платформа» и «маркетинговый сервис для роста в Telegram». URL — единственный
 * источник варианта, чтобы ссылку можно было расшарить и проиндексировать.
 */
const HERO_VARIANTS = {
  platform: {
    eyebrow: 'ИИ-платформа · Telegram',
    title: <>Десятки Telegram-профилей,<br /> которые работают <span className="text-gradient">к вашей цели</span></>,
    text: 'Парсинг, нейрокомментинг, нейрочаттинг, рассылки, прогрев и защита аккаунтов — в одном кабинете. Агенты со своим характером ведут людей по воронке до целевого действия.',
  },
  marketing: {
    eyebrow: 'Маркетинговый сервис · Telegram',
    title: <>Автоматический рост<br /> вашего бизнеса <span className="text-gradient">в Telegram</span></>,
    text: 'Поставьте цель — реклама группы, бота или сбор клиентов — и сервис ведёт её сам: находит аудиторию, пишет, вовлекает и приводит к целевому действию. Настроили и забыли.',
  },
} as const

export function LandingPage() {
  // Цены — с сервера, не из копии в вебе: публичная страница и счёт называют одно число.
  const [pricing, setPricing] = useState<Subscription | null>(null)
  useEffect(() => { void fetchSubscription().then(setPricing).catch(() => {}) }, [])

  const nav = useNavigate()
  const start = () => nav('/login')

  const [params] = useSearchParams()
  const variant = params.get('v') === 'marketing' ? 'marketing' : 'platform'
  // §10.6: два варианта шапки-героя, переключаются GET-параметром — чтобы можно было
  // выбрать без правки кода. `?hero=static` — один статичный экран; иначе — карусель.
  const heroStatic = params.get('hero') === 'static'
  const hero = HERO_VARIANTS[variant]
  // Годовая скидка — с сервера (правится в админке), catalog-константа как fallback.
  const annualDiscount = pricing?.annualDiscount ?? ANNUAL_DISCOUNT

  const setupAll = pricing?.setups.find((s) => s.id === 'setup-all') || null

  // Состояние калькулятора живёт здесь, чтобы готовые наборы могли его заполнять:
  // клик по пресету складывает его модули в калькулятор — иначе курируемые наборы
  // бесполезны рядом с ручной сборкой.
  const [planPeriod, setPlanPeriod] = useState<'month' | 'year'>('month')
  const [calcFull, setCalcFull] = useState(false)
  const [calcSelected, setCalcSelected] = useState<Set<string>>(new Set())
  const pickPreset = (mods: string[]) => {
    setCalcFull(false)
    setCalcSelected(new Set(mods))
    setTimeout(() => document.getElementById('calc')?.scrollIntoView({ behavior: 'smooth' }), 0)
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <Header start={start} />

      {/* ── Герой ─────────────────────────────────────────────── */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-14 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-iris-500/30 bg-iris-500/10 px-3 py-1 text-xs font-semibold text-iris-200">
            <Bot size={13} /> {hero.eyebrow}
          </span>
          <h1 className="mt-5 font-display text-4xl font-bold leading-[1.1] sm:text-5xl">
            {hero.title}
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
            {hero.text}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button onClick={start} className="btn-primary h-11 px-6 text-base">Начать <ArrowRight size={17} /></button>
            <a href="#modules" className="btn-ghost h-11 px-6 text-base">Возможности</a>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <Stat value="10+" label="модулей автоматизации" />
            <Stat value="24/7" label="работа к цели" />
            <Stat value="0" label="ручной рутины" />
          </div>
        </div>
        <HeroCarousel staticMode={heroStatic} />
      </section>

      {/* ── Как работает ─────────────────────────────────────── */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <SectionHead eyebrow="Автоматический конвейер" title="Настроили — и забыли" desc="Ставите цель — система сама ведёт её от холодной базы до заявок в CRM. Пять шагов, всё на автопилоте." />
          <div className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {FUNNEL_STEPS.map((s, i) => (
              <div key={s.title} className="rounded-2xl border border-line bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-300"><s.icon size={18} /></div>
                  <span className="font-display text-lg font-bold text-faint">0{i + 1}</span>
                </div>
                <div className="font-semibold">{s.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Модули (возможности) ─────────────────────────────── */}
      <section id="modules" className="mx-auto max-w-6xl px-5 py-16">
        <SectionHead eyebrow="Возможности" title="Всё, что нужно для продвижения" desc="10 модулей и менеджер аккаунтов в подарок. Один интерфейс, общий пул профилей." />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <div key={m.key} className="flex flex-col rounded-2xl border border-line bg-card p-5 transition-colors hover:border-spark-500/30">
              <div className="mb-3 flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-spark-500/12 text-spark-300"><m.icon size={20} /></div>
                {m.unique && <span className="ml-auto rounded-md bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">только у нас</span>}
              </div>
              <div className="font-semibold">{m.title}</div>
              <div className="text-xs text-muted">{m.tagline}</div>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted line-clamp-3">{m.description}</p>
              <Link to={`/module/${m.key}`} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-spark-300 hover:gap-2">
                Подробнее <ArrowRight size={15} />
              </Link>
            </div>
          ))}
          {/* Бонус */}
          <div className="flex flex-col rounded-2xl border border-spark-500/40 bg-spark-500/5 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-spark-500/15 text-spark-300"><BONUS_MODULE.icon size={20} /></div>
              <span className="ml-auto rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">в подарок</span>
            </div>
            <div className="font-semibold">{BONUS_MODULE.title}</div>
            <div className="text-xs text-muted">{BONUS_MODULE.tagline}</div>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted line-clamp-3">{BONUS_MODULE.description}</p>
            <Link to={`/module/${BONUS_MODULE.key}`} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-spark-300 hover:gap-2">
              Подробнее <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Цены ─────────────────────────────────────────────── */}
      <section id="tarify" className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <SectionHead eyebrow="Доступные тарифы" title="Цены" desc="Все модули или по отдельности — от $8. Работа ИИ оплачивается монетами: не работаете — не тратите." center />

          {/* Переключатель периода: помесячно или на год (год дешевле). */}
          <div className="mt-6 flex justify-center">
            <div className="flex rounded-xl border border-line bg-surface p-0.5 text-sm">
              {(['month', 'year'] as const).map((p) => (
                <button key={p} onClick={() => setPlanPeriod(p)} className={`h-9 rounded-lg px-4 font-semibold transition-colors ${planPeriod === p ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:text-fg'}`}>
                  {p === 'month' ? 'Помесячно' : 'На год'}
                  {p === 'year' && <span className="ml-1.5 text-[11px] text-spark-400">−{Math.round(annualDiscount * 100)}%</span>}
                </button>
              ))}
            </div>
          </div>

          {pricing && setupAll && (() => {
            const yr = planPeriod === 'year'
            const per = yr ? '/ год' : '/ мес'
            const perAll = yr ? Math.round(setupAll.cost.sum * 12 * (1 - annualDiscount)) : setupAll.cost.sum
            const perMin = yr ? Math.round(8 * 12 * (1 - annualDiscount)) : 8
            return (
              <div className="mx-auto mt-6 grid max-w-3xl gap-5 sm:grid-cols-2">
                <PlanCard
                  name="Полная подписка"
                  price={`${pricing.currency}${perAll}`}
                  per={per}
                  badge={yr ? `выгодно · −${Math.round(annualDiscount * 100)}%` : undefined}
                  highlight
                  desc={yr ? 'Все модули на год — дешевле помесячной.' : 'Доступ ко всем модулям на месяц.'}
                  features={['Все модули платформы', 'Новые модули — бесплатно', 'Менеджер аккаунтов в подарок']}
                  onStart={start}
                />
                <PlanCard
                  name="Отдельные модули"
                  price={`от ${pricing.currency}${perMin}`}
                  per={per}
                  desc="Соберите свой набор — платите только за нужное."
                  features={['Выбор отдельных модулей', 'Гибкая настройка', 'Скидка на готовый набор']}
                  onStart={() => { document.getElementById('calc')?.scrollIntoView({ behavior: 'smooth' }) }}
                  cta="К калькулятору"
                />
              </div>
            )
          })()}

          {/* Готовые наборы — курируемые пресеты дешевле поштучной сборки. Клик
              складывает набор в калькулятор, чтобы его можно было докрутить. */}
          {pricing && pricing.setups.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 text-sm font-semibold text-fg">Готовые наборы — дешевле, чем собирать поштучно</div>
              <div className="grid gap-4 sm:grid-cols-3">
                {[...pricing.setups].sort((a, b) => a.cost.sum - b.cost.sum).map((sp) => (
                  <div key={sp.id} className={`flex flex-col rounded-2xl border p-5 ${sp.id === 'setup-all' ? 'border-spark-500/50 bg-spark-500/5' : 'border-line bg-card'}`}>
                    <div className="font-display text-base font-bold">{sp.name}</div>
                    <div className="text-xs text-muted">{sp.hint}</div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-2">
                      <span className="font-display text-2xl font-bold">{pricing.currency}{sp.cost.sum}<span className="text-xs font-normal text-muted"> / мес</span></span>
                      {sp.discount > 0 && <span className="text-xs text-muted line-through">{pricing.currency}{sp.cost.full}</span>}
                      {sp.discount > 0 && <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(sp.discount * 100)}%</span>}
                    </div>
                    <ul className="mt-3 flex flex-1 flex-col gap-1 text-xs text-muted">
                      {sp.modules.slice(0, 6).map((mk) => (
                        <li key={mk} className="flex items-center gap-1.5"><Check size={12} className="shrink-0 text-spark-400" /> {pricing.items.find((i) => i.key === mk)?.title || mk}</li>
                      ))}
                      {sp.modules.length > 6 && <li className="text-faint">и ещё {sp.modules.length - 6}…</li>}
                    </ul>
                    <button onClick={() => pickPreset(sp.modules)} className="btn-ghost mt-4 h-9 rounded-xl border border-line text-sm font-semibold">Собрать в калькуляторе</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div id="calc" className="scroll-mt-8">
            {pricing && <PriceCalculator pricing={pricing} start={start} full={calcFull} setFull={setCalcFull} selected={calcSelected} setSelected={setCalcSelected} />}
          </div>
        </div>
      </section>

      {/* ── Сравнение ────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <SectionHead eyebrow="Сравнение" title="Почему выбирают Murmex" desc="Наши возможности против типовых альтернатив на рынке." center />
        <Comparison />
      </section>

      {/* ── Отзывы ───────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <SectionHead eyebrow="Отзывы" title="Что о нас говорят" desc="Иллюстративные отзывы — в демо-версии." center />
          <ReviewsCarousel />
        </div>
      </section>

      {/* ── Истории успеха ───────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <SectionHead eyebrow="Кейсы" title="Реальные истории успеха" desc="Как бизнесы используют Murmex для роста в Telegram (демо-примеры)." center />
        {/* §10.6: кейсы переработаны — фокус на РЕЗУЛЬТАТЕ. Метрика вынесена вверх крупно
            (это и есть крючок), отрасль — иконкой, срок — бейджем. */}
        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {CASES.map((c) => {
            const Icon = caseIcon(c.title)
            return (
              <div key={c.title} className="group relative overflow-hidden rounded-2xl border border-line bg-card p-5 transition-colors hover:border-spark-500/30">
                <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-spark-500/8 blur-2xl transition-opacity group-hover:opacity-80" />
                <div className="relative flex items-start gap-4">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-spark-500/12 text-spark-300"><Icon size={22} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted">{c.title}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-muted"><Clock size={12} /> {c.period}</span>
                    </div>
                    <div className="mt-1 font-display text-2xl font-bold leading-tight text-gradient">{c.metric}</div>
                  </div>
                </div>
                <p className="relative mt-3 text-sm leading-relaxed text-muted">{c.text}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Финальный призыв ─────────────────────────────────── */}
      <section className="border-t border-line bg-surface/40">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-5 py-14 sm:flex-row sm:items-center">
          <div>
            <div className="font-display text-xl font-bold">Попробуйте на своих каналах</div>
            <p className="mt-1.5 text-sm text-muted">Заведите профили, задайте цель — первые результаты видно в тот же день.</p>
          </div>
          <button onClick={start} className="btn-primary h-11 shrink-0 px-6 text-base sm:ml-auto">Начать <ArrowRight size={17} /></button>
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-5 py-8 text-xs text-muted">
        Murmex — платформа управления Telegram-профилями.
      </footer>
    </div>
  )
}

/* ─────────────────────────── Части ─────────────────────────── */

function Header({ start }: { start: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-spark-gradient text-[#04150c]"><Zap size={18} fill="currentColor" /></div>
        <div>
          <div className="font-display text-sm font-bold leading-tight">Murmex</div>
          <div className="text-[11px] leading-tight text-muted">управление Telegram-профилями</div>
        </div>
        <nav className="ml-auto hidden items-center gap-6 text-sm text-muted md:flex">
          <a href="#modules" className="hover:text-fg">Возможности</a>
          <a href="#tarify" className="hover:text-fg">Тарифы</a>
        </nav>
        <button onClick={start} className="ml-4 btn-primary h-9 px-4 text-sm">Войти <ArrowRight size={15} /></button>
      </div>
    </header>
  )
}

function SectionHead({ eyebrow, title, desc, center }: { eyebrow: string; title: string; desc: string; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <span className="text-xs font-bold uppercase tracking-wider text-spark-400">{eyebrow}</span>
      <h2 className="mt-2 font-display text-2xl font-bold sm:text-3xl">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-display text-2xl font-bold text-fg">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  )
}

/**
 * §10.6: карусель «скриншотов» кабинета — чистый CSS, не картинки (реальных скринов
 * под лендинг ещё нет, а один статичный мок показывал только менеджер аккаунтов).
 * Три экрана — аккаунты / нейродиалоги / отчёт — сами сменяются каждые ~4с, показывая
 * ширину продукта. Пауза при наведении; экраны сложены абсолютно и переключаются
 * через opacity, поэтому рамка не «прыгает» по высоте.
 */
const HERO_SCREENS = [
  { key: 'accounts', label: 'Аккаунты' },
  { key: 'dialogs', label: 'НейроДиалоги' },
  { key: 'report', label: 'Отчёт' },
] as const

function HeroCarousel({ staticMode = false }: { staticMode?: boolean }) {
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    // §10.6: статичный вариант шапки — без автопрокрутки (показываем один экран).
    if (paused || staticMode) return
    const id = setInterval(() => setI((p) => (p + 1) % HERO_SCREENS.length), 4000)
    return () => clearInterval(id)
  }, [paused, staticMode])

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full bg-spark-500/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-10 left-0 h-56 w-56 rounded-full bg-iris-500/15 blur-3xl" />
      <div className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-spark-400/70" />
          <span className="ml-3 text-[11px] text-muted">{HERO_SCREENS[i].label}</span>
          {/* Точки-переключатели только в режиме карусели. */}
          {!staticMode && (
            <div className="ml-auto flex gap-1.5">
              {HERO_SCREENS.map((s, k) => (
                <button
                  key={s.key}
                  onClick={() => setI(k)}
                  aria-label={s.label}
                  className={`h-1.5 rounded-full transition-all ${k === i ? 'w-5 bg-spark-400' : 'w-1.5 bg-line hover:bg-muted'}`}
                />
              ))}
            </div>
          )}
        </div>
        {/* Фиксированная высота — экраны сложены абсолютно, рамка не скачет при смене. */}
        <div className="relative h-[300px]">
          {HERO_SCREENS.map((s, k) => (
            <div
              key={s.key}
              className={`absolute inset-0 p-4 transition-opacity duration-500 ${k === i ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={k !== i}
            >
              {s.key === 'accounts' && <HeroAccounts />}
              {s.key === 'dialogs' && <HeroDialogs />}
              {s.key === 'report' && <HeroReport />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function HeroAccounts() {
  const rows = [
    { n: 'Ethan Walker', s: 'Валидный', c: 'text-spark-300' },
    { n: 'Mia Hartley', s: 'Прогрев', c: 'text-amber-300' },
    { n: 'Sophie Dane', s: 'Валидный', c: 'text-spark-300' },
    { n: 'Nexus Media', s: 'Реакции', c: 'text-iris-300' },
  ]
  return (
    <div className="space-y-2">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[['6', 'Активные'], ['80', 'монет ⚡'], ['0', 'банов']].map(([v, l]) => (
          <div key={l} className="rounded-xl border border-line bg-card p-3">
            <div className="font-display text-xl font-bold">{v}</div>
            <div className="text-[10px] text-muted">{l}</div>
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.n} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-elevated text-[11px] font-bold text-muted">{r.n[0]}</div>
          <span className="text-sm font-medium">{r.n}</span>
          <span className={`ml-auto text-xs font-semibold ${r.c}`}>{r.s}</span>
        </div>
      ))}
    </div>
  )
}

function HeroDialogs() {
  const msgs = [
    { out: false, t: 'Привет! Подскажите по тарифам?' },
    { out: true, t: 'Здравствуйте! Конечно — под какую задачу подбираем? 🙂' },
    { out: false, t: 'Реклама канала, хочу живых подписчиков' },
    { out: true, t: 'Отлично, это наш профиль. Соберём аудиторию и приведём к вам — покажу как.' },
  ]
  return (
    <div className="flex h-full flex-col gap-2">
      {msgs.map((m, k) => (
        <div key={k} className={`max-w-[82%] rounded-2xl px-3 py-2 text-xs leading-snug ${m.out ? 'ml-auto bg-spark-500/15 text-fg' : 'bg-card text-muted'}`}>
          {m.t}
        </div>
      ))}
      <div className="mt-auto flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-[11px] text-faint">
        <Bot size={13} className="text-spark-300" /> ИИ ведёт диалог к цели · отвечает на языке собеседника
      </div>
    </div>
  )
}

function HeroReport() {
  const bars = [70, 45, 88, 60, 95, 52, 78]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[['1 240', 'лидов'], ['18%', 'в диалог'], ['4.2×', 'ROI']].map(([v, l]) => (
          <div key={l} className="rounded-xl border border-line bg-card p-3">
            <div className="font-display text-xl font-bold text-spark-300">{v}</div>
            <div className="text-[10px] text-muted">{l}</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span>Активность за неделю</span><span className="inline-flex items-center gap-1 text-spark-300"><TrendingUp size={12} /> рост</span>
        </div>
        <div className="flex h-24 items-end gap-2">
          {bars.map((h, k) => (
            <div key={k} className="flex-1 rounded-t bg-spark-gradient" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanCard({ name, price, per, desc, features, onStart, badge, highlight, cta }: {
  name: string; price: string; per: string; desc: string; features: string[]; onStart: () => void; badge?: string; highlight?: boolean; cta?: string
}) {
  return (
    <div className={`relative flex flex-col rounded-2xl border p-6 ${highlight ? 'border-spark-500/50 bg-spark-500/5' : 'border-line bg-card'}`}>
      {badge && (
        <span className="absolute -top-3 left-6 rounded-full bg-spark-gradient px-2.5 py-0.5 text-[11px] font-bold text-[#04150c]">{badge}</span>
      )}
      <div className="font-display text-lg font-bold">{name}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-display text-3xl font-bold">{price}</span>
        <span className="text-sm text-muted">{per}</span>
      </div>
      <div className="mt-1 text-sm text-muted">{desc}</div>
      <ul className="mt-5 flex flex-1 flex-col gap-2">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-muted"><Check size={15} className="mt-0.5 shrink-0 text-spark-400" /> {f}</li>
        ))}
      </ul>
      <button onClick={onStart} className={`mt-6 h-10 rounded-xl text-sm font-semibold ${highlight ? 'btn-primary' : 'btn-ghost border border-line'}`}>{cta || 'Выбрать'}</button>
    </div>
  )
}

/**
 * §10.6: карусель отзывов вместо статичной сетки — их стало больше, чем помещается
 * в два столбца, а листать руками на лендинге никто не будет. Автопрокрутка каждые
 * 5с, пауза при наведении/фокусе, точки-навигация. Основа — нативный scroll-snap:
 * сам по себе адаптивен (2 карточки на десктопе, 1 на телефоне) и не ломает клавиатуру.
 */
function ReviewsCarousel() {
  const trackRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)

  const scrollTo = (i: number) => {
    const track = trackRef.current
    if (!track) return
    const card = track.children[i] as HTMLElement | undefined
    if (card) track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: 'smooth' })
  }

  // Автопрокрутка: раз в 5с к следующей карточке, по кругу. Пауза — при наведении,
  // чтобы читающий отзыв не «уезжал» из-под курсора.
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      setActive((prev) => {
        const next = (prev + 1) % REVIEWS.length
        scrollTo(next)
        return next
      })
    }, 5000)
    return () => clearInterval(id)
  }, [paused])

  // Активная точка следует за реальным скроллом (свайп/клавиатура/автопрокрутка) —
  // считаем ближайшую к левому краю карточку.
  const onScroll = () => {
    const track = trackRef.current
    if (!track) return
    let nearest = 0
    let best = Infinity
    Array.from(track.children).forEach((c, i) => {
      const d = Math.abs((c as HTMLElement).offsetLeft - track.offsetLeft - track.scrollLeft)
      if (d < best) { best = d; nearest = i }
    })
    setActive(nearest)
  }

  return (
    <div
      className="mt-8"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="no-scrollbar flex snap-x snap-mandatory gap-5 overflow-x-auto scroll-smooth pb-1"
      >
        {REVIEWS.map((r) => (
          <figure
            key={r.name}
            className="flex w-[85%] shrink-0 snap-start flex-col rounded-2xl border border-line bg-card p-5 sm:w-[calc(50%-10px)]"
          >
            <Quote size={22} className="text-spark-400/60" />
            <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{r.text}</p>
            <figcaption className="mt-4 flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-spark-500/15 font-bold text-spark-300">{r.name[0]}</div>
              <div>
                <div className="text-sm font-semibold">{r.name}</div>
                <div className="text-xs text-muted">{r.role}</div>
              </div>
              <div className="ml-auto flex items-center gap-0.5 text-amber-300">
                {Array.from({ length: 5 }).map((_, i) => <Star key={i} size={13} fill="currentColor" />)}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="mt-5 flex justify-center gap-2">
        {REVIEWS.map((r, i) => (
          <button
            key={r.name}
            onClick={() => { setActive(i); scrollTo(i) }}
            aria-label={`Отзыв ${i + 1}`}
            className={`h-2 rounded-full transition-all ${i === active ? 'w-6 bg-spark-400' : 'w-2 bg-line hover:bg-muted'}`}
          />
        ))}
      </div>
    </div>
  )
}

function Comparison() {
  const cell = (v: Cmp) =>
    v === 'yes' ? <Check size={16} className="mx-auto text-spark-400" />
      : v === 'partial' ? <Minus size={16} className="mx-auto text-amber-400" />
        : <X size={16} className="mx-auto text-faint" />
  const cols: { key: 'us' | 'parsers' | 'mailers' | 'neuro'; label: string; sub?: string }[] = [
    { key: 'us', label: 'Murmex', sub: 'лучший выбор' },
    { key: 'parsers', label: 'Парсеры', sub: 'аналитика каналов' },
    { key: 'mailers', label: 'Рассыльщики', sub: 'ЛС-софт' },
    { key: 'neuro', label: 'Нейросервисы', sub: 'комментинг' },
  ]
  return (
    <div className="mt-8 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr>
            <th className="p-3 text-left font-medium text-muted">Функция</th>
            {cols.map((c) => (
              <th key={c.key} className={`p-3 text-center ${c.key === 'us' ? 'rounded-t-xl bg-spark-500/8' : ''}`}>
                <div className={`font-bold ${c.key === 'us' ? 'text-spark-300' : 'text-fg'}`}>{c.label}</div>
                {c.sub && <div className="text-[11px] font-normal text-muted">{c.sub}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARISON.map((row) => (
            <tr key={row.feature} className="border-t border-line">
              <td className="p-3 text-fg">{row.feature}</td>
              {cols.map((c) => (
                <td key={c.key} className={`p-3 ${c.key === 'us' ? 'bg-spark-500/8' : ''}`}>{cell(row[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Калькулятор набора: клиент отмечает нужные модули и сразу видит цену со скидкой
 * готового сетапа. Цену считает сервер (quoteSubscription). «Полная лицензия» — тумблер:
 * включает всё, поштучный выбор гаснет (серые, неактивные) — уже включено.
 */
function PriceCalculator({ pricing, start, full, setFull, selected, setSelected }: {
  pricing: Subscription
  start: () => void
  full: boolean
  setFull: Dispatch<SetStateAction<boolean>>
  selected: Set<string>
  setSelected: Dispatch<SetStateAction<Set<string>>>
}) {
  const allKeys = useMemo(() => pricing.items.map((i) => i.key), [pricing.items])
  const [period, setPeriod] = useState<'month' | 'year'>('month')
  const [cost, setCost] = useState<SubCost | null>(null)

  const activeKeys = useMemo(() => (full ? allKeys : [...selected]), [full, selected, allKeys])
  useEffect(() => {
    if (!activeKeys.length) { setCost(null); return }
    let alive = true
    void quoteSubscription(activeKeys).then((c) => { if (alive) setCost(c) }).catch(() => { if (alive) setCost(null) })
    return () => { alive = false }
  }, [activeKeys])

  const annualDiscount = pricing.annualDiscount ?? ANNUAL_DISCOUNT
  const perPeriod = (monthly: number) => (period === 'year' ? Math.round(monthly * 12 * (1 - annualDiscount)) : monthly)
  const suffix = period === 'year' ? ' / год' : ' / мес'
  const cur = pricing.currency

  const toggle = (k: string) => {
    if (full) return
    setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }

  const total = cost ? perPeriod(cost.sum) : 0
  const totalFull = cost ? perPeriod(cost.full) : 0
  const hasDiscount = !!cost && cost.full > cost.sum

  return (
    <div className="mt-8 rounded-2xl border border-line bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-lg font-bold">Калькулятор — соберите свой набор</div>
          <p className="mt-1 text-sm text-muted">Отметьте нужные модули — цена посчитается сразу.</p>
        </div>
        <div className="flex rounded-xl border border-line bg-surface p-0.5 text-sm">
          {(['month', 'year'] as const).map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`h-8 rounded-lg px-3 font-semibold transition-colors ${period === p ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:text-fg'}`}>
              {p === 'month' ? 'Месяц' : 'Год'}
              {p === 'year' && <span className="ml-1 text-[10px] text-spark-400">−{Math.round(annualDiscount * 100)}%</span>}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => setFull((v) => !v)}
        className={`mt-4 flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors ${full ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-surface hover:border-spark-500/30'}`}
      >
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border ${full ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line'}`}>{full && <Check size={15} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Полная лицензия — всё включено</span>
          <span className="block text-xs text-muted">Все {allKeys.length} модулей платформы. Новые — бесплатно.</span>
        </span>
      </button>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pricing.items.map((m) => {
          const on = full || selected.has(m.key)
          const included = full
          const Icon = moduleIcon(m.key)
          return (
            <div
              key={m.key}
              className={`relative flex flex-col rounded-xl border p-4 transition-colors ${included ? 'border-line bg-surface/40 opacity-60' : on ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-surface'}`}
            >
              <button
                onClick={() => toggle(m.key)}
                disabled={included}
                className={`flex items-start gap-3 text-left ${included ? 'cursor-not-allowed' : ''}`}
              >
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${on && !included ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line text-muted'}`}>
                  {included ? <Lock size={12} /> : on ? <Check size={13} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-semibold"><Icon size={14} className="shrink-0 text-spark-300" /> {m.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">{moduleTagline(m.key)}</span>
                  <span className="mt-1 block text-sm"><span className="font-bold tabular-nums text-fg">{cur}{perPeriod(m.price)}</span><span className="text-xs font-normal text-muted">{suffix}</span></span>
                </span>
              </button>
              <Link to={`/module/${m.key}`} className="mt-2 inline-flex items-center gap-1 self-start text-[11px] font-semibold text-spark-300 hover:gap-1.5">
                Подробнее <ArrowRight size={12} />
              </Link>
              {included && <span className="absolute right-3 top-3 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">включено</span>}
            </div>
          )
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5">
        <div>
          <div className="text-xs text-muted">{full ? 'Полная лицензия' : activeKeys.length ? `Выбрано модулей: ${activeKeys.length}` : 'Ничего не выбрано'}</div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold text-fg">{cur}{total}<span className="text-sm font-normal text-muted">{suffix}</span></span>
            {hasDiscount && (
              <>
                <span className="text-sm text-muted line-through">{cur}{totalFull}</span>
                <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round((cost!.discount || 0) * 100)}%</span>
              </>
            )}
          </div>
        </div>
        <button onClick={start} disabled={!activeKeys.length} className="btn-primary ml-auto h-11 px-6 text-base disabled:opacity-40">Оформить <ArrowRight size={17} /></button>
      </div>
    </div>
  )
}
