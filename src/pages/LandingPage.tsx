import { useNavigate } from 'react-router-dom'
import {
  Bot, Radar, MessagesSquare, ShieldCheck, Target, BarChart3,
  ArrowRight, Check, Zap,
} from 'lucide-react'
import { PLAN_CARDS, CURRENCY } from '@/shared/config/plans'

/**
 * B1 (SPEC §5.2): публичный лендинг — единственная страница вне auth-гейта панели.
 *
 * Задача страницы одна: объяснить, что это, и довести до регистрации или оплаты.
 * Поэтому здесь нет ни демо-данных, ни «интерактива ради интерактива» — только то,
 * что человек должен понять, прежде чем заводить аккаунты и платить.
 *
 * Тарифы берутся из общего конфига, а не переписаны текстом: цифры на лендинге и
 * лимиты в системе должны совпадать, иначе клиент заплатит за одно, а получит другое.
 */

const FEATURES = [
  {
    icon: <Bot size={20} />,
    title: 'Агенты вместо шаблонов',
    text: 'AI-персона с характером, тоном и запретами. Под одной целью можно вести две линии: одни аккаунты хвалят, другие спорят — и это выглядит как живое обсуждение, а не рассылка.',
  },
  {
    icon: <Target size={20} />,
    title: 'Работа к цели, а не «по кнопке»',
    text: 'Цель задаёт измеримый результат: лиды, переходы, срок. Модули ведут человека по воронке и прощаются, когда целевое действие выполнено.',
  },
  {
    icon: <Radar size={20} />,
    title: 'Свои базы каналов и аудитории',
    text: 'Парсеры собирают каналы, группы и участников по ключевым словам, фильтруют по активности и размеру. Найденное сразу идёт в работу.',
  },
  {
    icon: <MessagesSquare size={20} />,
    title: 'Комментинг, чатинг, рассылка',
    text: 'Осмысленные комментарии под постами, ответы в группах, личные диалоги и автопостинг в свои каналы — на общем пуле профилей, без конфликтов.',
  },
  {
    icon: <ShieldCheck size={20} />,
    title: 'Профили ведут себя как люди',
    text: 'Усталость и распорядок дня: после смены аккаунт отдыхает во всех модулях сразу, ночью не пишет, отвечает не мгновенно. Именно по таким мелочам Telegram и вычисляет ботов.',
  },
  {
    icon: <BarChart3 size={20} />,
    title: 'Видно, за что платите',
    text: 'Расход считается построчно: модуль, аккаунт, задача. Постатейный отчёт выгружается одним файлом — без «поверьте на слово».',
  },
]

export function LandingPage() {
  const nav = useNavigate()
  const start = () => nav('/login')

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* Шапка */}
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-spark-gradient text-[#04150c]">
            <Zap size={18} fill="currentColor" />
          </div>
          <div>
            <div className="font-display text-sm font-bold leading-tight">AI Incubator</div>
            <div className="text-[11px] leading-tight text-muted">управление Telegram-профилями</div>
          </div>
          <button onClick={start} className="btn-primary ml-auto h-9 px-4 text-sm">
            Войти <ArrowRight size={15} />
          </button>
        </div>
      </header>

      {/* Первый экран */}
      <section className="mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pt-24">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-iris-500/30 bg-iris-500/10 px-3 py-1 text-xs font-semibold text-iris-200">
            <Bot size={13} /> AI-агенты · Telegram
          </span>
          <h1 className="mt-5 font-display text-4xl font-bold leading-[1.1] sm:text-5xl">
            Десятки Telegram-профилей,
            <br />
            которые работают к вашей цели
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
            Не массовая рассылка, а осмысленное присутствие: агенты комментируют посты,
            отвечают в группах и ведут переписку — каждый со своим характером, своим
            распорядком дня и общим счётчиком усталости.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button onClick={start} className="btn-primary h-11 px-6 text-base">
              Начать <ArrowRight size={17} />
            </button>
            <a href="#tarify" className="btn-ghost h-11 px-6 text-base">Тарифы</a>
          </div>
        </div>
      </section>

      {/* Что делает */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-2xl font-bold">Что внутри</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-card p-5">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-spark-500/12 text-spark-300">
                  {f.icon}
                </div>
                <div className="mb-1.5 font-semibold">{f.title}</div>
                <p className="text-sm leading-relaxed text-muted">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Тарифы */}
      <section id="tarify" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="font-display text-2xl font-bold">Тарифы</h2>
        <p className="mt-2 text-sm text-muted">
          Оплата монетами: списываются за работу ИИ. Не работаете — не тратите.
        </p>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {PLAN_CARDS.map((p) => (
            <div
              key={p.id}
              className={`flex flex-col rounded-2xl border p-6 ${
                p.featured ? 'border-spark-500/50 bg-spark-500/5' : 'border-line bg-card'
              }`}
            >
              {p.featured && (
                <span className="mb-3 self-start rounded-full bg-spark-500/15 px-2.5 py-0.5 text-[11px] font-bold text-spark-300">
                  чаще выбирают
                </span>
              )}
              <div className="font-display text-lg font-bold">{p.name}</div>
              {/* Цена появляется автоматически, как только её проставят в plans.ts.
                  Пока null — честное «по запросу» вместо выдуманной суммы. */}
              <div className="mt-1 font-display text-2xl font-bold text-fg">
                {p.pricePerMonth != null
                  ? <>{CURRENCY}{p.pricePerMonth}<span className="text-sm font-normal text-muted"> / мес</span></>
                  : <span className="text-base font-semibold text-muted">Цена по запросу</span>}
              </div>
              <div className="mt-1 text-sm text-muted">до {p.accountLimit} аккаунтов</div>
              <ul className="mt-5 flex flex-1 flex-col gap-2">
                {p.perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-2 text-sm">
                    <Check size={15} className="mt-0.5 shrink-0 text-spark-400" />
                    <span className="text-muted">{perk}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={start}
                className={`mt-6 h-10 rounded-xl text-sm font-semibold ${
                  p.featured ? 'btn-primary' : 'btn-ghost border border-line'
                }`}
              >
                Выбрать
              </button>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs text-muted">
          Точная стоимость и условия — по запросу: тарифная сетка согласуется индивидуально.
        </p>
      </section>

      {/* Финальный призыв */}
      <section className="border-t border-line bg-surface/40">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-5 py-14 sm:flex-row sm:items-center">
          <div>
            <div className="font-display text-xl font-bold">Попробуйте на своих каналах</div>
            <p className="mt-1.5 text-sm text-muted">
              Заведите профили, задайте цель — первые результаты видно в тот же день.
            </p>
          </div>
          <button onClick={start} className="btn-primary h-11 shrink-0 px-6 text-base sm:ml-auto">
            Начать <ArrowRight size={17} />
          </button>
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-5 py-8 text-xs text-muted">
        AI Incubator — платформа управления Telegram-профилями.
      </footer>
    </div>
  )
}
