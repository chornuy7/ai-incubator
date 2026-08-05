import { useEffect, useMemo, useState } from 'react'
import { GraduationCap, Search, ChevronRight, Eye, Cog, Network, Lightbulb, ShieldAlert, Sparkles, ListChecks, BookOpen, Users, Flame, Hash, Heart, Gauge, Rocket, Activity, type LucideIcon } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { HELP_DOCS, type HelpDoc } from '@/shared/config/helpDocs'
import { cn } from '@/shared/lib/utils'
import { MODULES, isCombatModule } from '@/shared/config/modules'
import { ModuleShowcase } from './landing/ModuleShowcase'
import { getModule } from './landing/catalog'

/**
 * §9 (MR-47): пошаговый формат «с чего начать» по каждому модулю. Шаги СОБИРАЮТСЯ из
 * конфига модуля (MODULES) — какие блоки ему нужны (аккаунты, цели, промпт, реакции,
 * прогрев), поэтому инструкция всегда точна и не расходится с реальным интерфейсом, а
 * не пишется руками для каждого модуля. Простые короткие шаги «сделай 1 → 2 → 3».
 */
export function moduleSteps(key: string): { title: string; text: string; icon: LucideIcon }[] | null {
  const m = MODULES[key]
  if (!m) return null
  const steps: { title: string; text: string; icon: LucideIcon }[] = []
  steps.push({ icon: BookOpen, title: `Откройте «${m.title}»`, text: 'Модуль — в левом меню. Откроется страница запуска с настройками и кнопкой «Запустить» внизу.' })
  if (m.accountPicker) steps.push({ icon: Users, title: 'Выберите аккаунты', text: 'Отметьте аккаунты из пула, которыми будет работать модуль. Занятые в другой задаче — недоступны. Больше аккаунтов — равномернее нагрузка и безопаснее.' })
  if (m.warmingLayout) steps.push({ icon: Flame, title: 'Настройте прогрев', text: 'Выберите уровень/интенсивность прогрева. Цели не нужны — модуль сам имитирует живую активность аккаунтов.' })
  if (m.sourceTabs || m.postLinks) {
    const unit = m.unit?.title ? m.unit.title.toLowerCase() : 'цели'
    const src = m.postLinks ? `${unit} или ссылки на посты` : unit
    steps.push({ icon: Hash, title: `Добавьте ${unit}`, text: `Вставьте ${src} вручную, загрузите из папки или из прошлой задачи. Их число видно на карточке-счётчике. Ненужное можно занести в чёрный список.` })
  }
  if (m.messagePrompts?.length) steps.push({ icon: Sparkles, title: 'Задайте тон / промпт', text: `Выберите тип (${m.messagePrompts.slice(0, 3).join(', ')}…). Если типов несколько — задайте их доли в процентах: сумма всегда 100%, замок закрепляет долю.` })
  if (m.reactionSettings) steps.push({ icon: Heart, title: 'Выберите реакции', text: 'Отметьте эмодзи, которыми аккаунты будут реагировать на посты.' })
  steps.push({ icon: Gauge, title: 'Проверьте лимиты и стоимость', text: 'Сверху — карточки «Аккаунты», «Цели», «≈ время», «Лимит». Под ними — примерная стоимость запуска в токенах. Обязательные незаполненные поля подсвечены, кнопка запуска пока заблокирована.' })
  steps.push({ icon: Rocket, title: 'Запустите', text: isCombatModule(key) ? 'Нажмите «Запустить» — для боевого модуля будет запрос подтверждения. Задача уйдёт в работу.' : 'Нажмите «Запустить» — задача уйдёт в работу.' })
  steps.push({ icon: Activity, title: 'Следите за результатом', text: 'Прогресс, лог каждого действия и управление (пауза/стоп) — в «Дашборде задач». Там же результаты и ошибки.' })
  return steps
}

/**
 * §10.7: страница «Обучение» — вся информация по работе в одном месте.
 *
 * Собирается ИЗ доков Help Center (HELP_DOCS) — тех же, что всплывают по «?» на
 * страницах. Один источник правды: добавили/поменяли описание модуля в helpDocs —
 * оно тут же в обучении, руками ничего не дублируется (созвон 27.07: «дока модуля
 * собирается из описаний блоков»).
 *
 * Группы — чтобы длинный список читался: модули, парсеры, правила, доступы.
 */
const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Модули', keys: ['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-react', 'mass-looking', 'warming', 'autoposting', 'mailing-rules', 'ggr', 'channel-rating'] },
  { title: 'Парсеры', keys: ['parsing', 'parsing-groups', 'parsing-users', 'parsing-messages', 'parsing-comments'] },
  { title: 'Безопасность и правила', keys: ['safety-limits', 'trust-autostop', 'warming-policy', 'captcha-antispam', 'proxy-policy'] },
  { title: 'Доступы и разделы', keys: ['rbac-roles', 'accounts-manager', 'automation', 'goals', 'campaign', 'crm', 'analytics', 'logs'] },
]

export function LearningPage() {
  const [q, setQ] = useState('')
  const [active, setActive] = useState<string | null>(null)

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((g) => ({
    ...g,
    items: g.keys
      .map((k) => ({ key: k, doc: HELP_DOCS[k] }))
      .filter((x): x is { key: string; doc: HelpDoc } => !!x.doc)
      .filter((x) => !needle || `${x.doc.title} ${x.doc.what}`.toLowerCase().includes(needle)),
  })).filter((g) => g.items.length), [needle])

  const activeDoc = active ? HELP_DOCS[active] : null

  return (
    <LearningView
      q={q} setQ={setQ} groups={groups} active={active} setActive={setActive} activeDoc={activeDoc}
    />
  )
}

/**
 * §10.7: карточка темы — не «простыня» из шести абзацев сразу (созвон: «слишком сложно
 * для восприятия»), а вкладки. Человек видит один смысловой кусок за раз и сам решает,
 * копать ли глубже. Тот же компонент потом продублируется на публичный сайт.
 */
function LearningView({ q, setQ, groups, active, setActive, activeDoc }: {
  q: string
  setQ: (v: string) => void
  groups: { title: string; items: { key: string; doc: HelpDoc }[] }[]
  active: string | null
  setActive: (k: string) => void
  activeDoc: HelpDoc | null
}) {
  // Вкладки собираем только из непустых секций дока — у разных тем свой набор.
  const tabs = useMemo(() => {
    if (!activeDoc) return [] as { key: string; label: string; icon: typeof Eye; body?: string; tips?: string[]; steps?: { title: string; text: string; icon: LucideIcon }[]; accent?: boolean; warn?: boolean }[]
    // §9 (MR-47): для модуля первой идёт вкладка «С чего начать» — пошаговая инструкция.
    const steps = active ? moduleSteps(active) : null
    return [
      ...(steps ? [{ key: 'steps', label: 'С чего начать', icon: ListChecks, steps }] : []),
      { key: 'what', label: 'Обзор', icon: Eye, body: activeDoc.what },
      { key: 'how', label: 'Как работает', icon: Cog, body: activeDoc.how },
      { key: 'together', label: 'Связи', icon: Network, body: activeDoc.together },
      { key: 'example', label: 'Пример', icon: Sparkles, body: activeDoc.example, accent: true },
      ...(activeDoc.risks ? [{ key: 'risks', label: 'Риски', icon: ShieldAlert, body: activeDoc.risks, warn: true }] : []),
      ...(activeDoc.tips?.length ? [{ key: 'tips', label: 'Советы', icon: Lightbulb, tips: activeDoc.tips }] : []),
    ].filter((t) => t.tips?.length || t.steps?.length || t.body?.trim())
  }, [activeDoc, active])

  const [tab, setTab] = useState('what')
  // Сменили тему — открываем первую вкладку (для модуля это «С чего начать», иначе «Обзор»),
  // иначе открытая вкладка «Риски» перетекала бы на тему, где рисков нет.
  useEffect(() => { setTab(tabs[0]?.key ?? 'what') }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = tabs.find((t) => t.key === tab) ?? tabs[0]

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<GraduationCap size={20} />}
        title="Обучение"
        subtitle="Как устроена платформа и каждый модуль — вся справка в одном месте. Обновляется автоматически из Help Center."
      />

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="p-3">
          <div className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по темам…" className="input h-9 w-full pl-9 text-sm" />
          </div>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {groups.map((g) => (
              <div key={g.title}>
                <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-muted">{g.title}</div>
                {g.items.map((x) => (
                  <button
                    key={x.key}
                    onClick={() => setActive(x.key)}
                    className={cn('flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                      active === x.key ? 'bg-spark-500/12 text-spark-200' : 'text-muted hover:bg-white/[.03] hover:text-fg')}
                  >
                    <ChevronRight size={13} className="shrink-0 opacity-60" /> {x.doc.title}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <div className="px-2 py-4 text-sm text-muted">Ничего не найдено.</div>}
          </div>
        </Card>

        <Card className="p-5">
          {!activeDoc ? (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-muted">
              <GraduationCap size={32} className="mb-3 opacity-40" />
              <div className="text-sm">Выберите тему слева — откроется подробное объяснение:<br />что это, как работает, риски и пример.</div>
            </div>
          ) : (
            <article className="space-y-4">
              <h2 className="font-display text-2xl font-bold text-fg">{activeDoc.title}</h2>

              {/* §11.6: если раздел — это модуль, показываем его картинку с выносками
                  тем же компонентом, что на странице модуля: «все хотят смотреть глазками». */}
              {active && getModule(active) && <ModuleShowcase moduleKey={active} title={activeDoc.title} />}

              {/* Вкладки: один кусок за раз вместо шести абзацев подряд. */}
              <div className="flex flex-wrap gap-1.5 border-b border-line pb-3">
                {tabs.map((t) => {
                  const on = shown?.key === t.key
                  const Icon = t.icon
                  return (
                    <button
                      key={t.key}
                      onClick={() => setTab(t.key)}
                      className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                        on
                          ? (t.warn ? 'bg-amber-500/15 text-amber-200' : 'bg-spark-500/15 text-spark-200')
                          : 'text-muted hover:bg-white/[.04] hover:text-fg')}
                    >
                      <Icon size={13} /> {t.label}
                    </button>
                  )
                })}
              </div>

              {/* Тело активной вкладки. Заголовок не дублируем — он уже на самой вкладке. */}
              <div key={shown?.key}>
                {shown?.steps
                  ? <StepList steps={shown.steps} />
                  : shown?.tips
                    ? (
                      <ul className="space-y-2">
                        {shown.tips.map((t, i) => (
                          <li key={i} className="flex gap-2.5 rounded-xl border border-line bg-elevated/40 p-3 text-sm text-muted">
                            <Lightbulb size={15} className="mt-0.5 shrink-0 text-spark-400" /> {t}
                          </li>
                        ))}
                      </ul>
                    )
                    : shown
                      ? <Section body={shown.body || ''} accent={shown.accent} warn={shown.warn} />
                      : null}
              </div>
            </article>
          )}
        </Card>
      </div>
    </div>
  )
}

/**
 * §9 (MR-47): пошаговый формат — крупные пронумерованные шаги, соединённые линией.
 * «Понятно даже ребёнку»: один шаг = одно действие, по порядку сверху вниз.
 */
function StepList({ steps }: { steps: { title: string; text: string; icon: LucideIcon }[] }) {
  return (
    <ol className="relative space-y-3">
      {steps.map((s, i) => {
        const Icon = s.icon
        return (
          <li key={i} className="relative flex gap-3">
            {/* Соединительная линия между кружками-иконками. */}
            {i < steps.length - 1 && <span className="absolute left-[17px] top-9 h-[calc(100%-1rem)] w-px bg-line" aria-hidden />}
            {/* Номер + иконка шага: наглядно «даже ребёнку» — что за действие. */}
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-spark-500/15 text-spark-300 ring-1 ring-spark-500/30">
              <Icon size={17} />
              <span className="absolute -left-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-spark-500 text-[10px] font-bold text-[#04150c]">{i + 1}</span>
            </span>
            <div className="min-w-0 flex-1 rounded-xl border border-line bg-elevated/40 p-3">
              <div className="text-sm font-semibold text-fg">{s.title}</div>
              <div className="mt-0.5 text-sm leading-relaxed text-muted">{s.text}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Section({ title, body, accent, warn }: { title?: string; body: string; accent?: boolean; warn?: boolean }) {
  return (
    <div>
      {title && <div className={cn('mb-1.5 text-xs font-bold uppercase tracking-wide', warn ? 'text-amber-300' : 'text-muted')}>{title}</div>}
      <p className={cn('whitespace-pre-wrap text-sm leading-relaxed',
        accent ? 'rounded-xl border border-spark-500/25 bg-spark-500/6 p-3 text-fg' : warn ? 'text-amber-100/80' : 'text-muted')}>{body}</p>
    </div>
  )
}
