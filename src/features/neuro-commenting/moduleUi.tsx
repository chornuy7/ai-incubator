import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Switch } from '@/shared/ui'
import { HelpCircle } from 'lucide-react'
import { useUi } from '@/shared/lib/uiStore'

/**
 * §13: открыть Help по блоку модуля и удержать САМ БЛОК в поле зрения.
 *
 * Панель помощи — не оверлей, а колонка в потоке (`HelpCenterDrawer`): при открытии
 * страница сужается и перевёрстывается, из-за чего блок, у которого нажали «?»,
 * уезжает из вида — приходится искать его глазами и скроллить руками.
 *
 * Скроллим к блоку ПОСЛЕ перевёрстки: два кадра (state → render → layout), иначе
 * посчитаем позицию по старой, ещё широкой раскладке и промахнёмся.
 */
export function revealHelpBlock(el: HTMLElement | null) {
  if (!el) return
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  }))
}

/** Приводит ввод к целому в пределах [min, max]. */
function clampInt(raw: number | string, min: number, max?: number) {
  let n = Math.round(Number(raw))
  if (!Number.isFinite(n)) n = min
  if (n < min) n = min
  if (max !== undefined && n > max) n = max
  return n
}

/** Кнопка Help Center для карточек, которые не построены на SectionCard. */
export function HelpButton({ topic, className }: { topic: string; className?: string }) {
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)

  // Карточка блока, внутри которой стоит кнопка, — к ней возвращаем взгляд после
  // открытия панели (у этой кнопки нет своей обёртки, поэтому ищем ближайшую .card).
  const open = (el: HTMLElement | null) => {
    setHelpTopic(topic)
    setHelpOpen(true)
    revealHelpBlock(el?.closest('.card') as HTMLElement | null)
  }

  return (
    <span
      role="button"
      tabIndex={0}
      title="Help Center"
      aria-label="Help Center"
      onClick={(e) => { e.stopPropagation(); open(e.currentTarget) }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        open(e.currentTarget)
      }}
      className={cn(
        'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-xl bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.03]',
        className,
      )}
    >
      <HelpCircle size={16} />
    </span>
  )
}

export function SectionCard({ icon, title, badge, right, required, children, id }: {
  icon: React.ReactNode; title: string; badge?: string; right?: React.ReactNode
  /** §11 (MR-54): пометить блок обязательным — визуально отделить от необязательных настроек. */
  required?: boolean
  children: React.ReactNode
  /** Якорь для шагов мастера запуска: клик по шагу прокручивает к этому блоку. */
  id?: string
}) {
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)
  const rootRef = useRef<HTMLDivElement>(null)

  // scroll-mt — чтобы липкая шапка не накрывала заголовок при переходе по якорю.
  return (
    <div ref={rootRef} id={id} className="card scroll-mt-24 p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400">{icon}</span>
        <span className="font-display text-base font-bold text-fg">{title}</span>
        {/* §12 (UI-004): счётчик (badge) — ДО отметки «обязательно». */}
        {badge && <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{badge}</span>}
        {required && <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300" title="Без этого блока запуск недоступен">обязательно</span>}
        <div className="ml-auto flex items-center gap-2">
          {right && <div>{right}</div>}
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-xl bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.03]"
            title="Help Center"
            aria-label="Help Center"
            onClick={() => { setHelpTopic(title); setHelpOpen(true); revealHelpBlock(rootRef.current) }}
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </div>
      {/* Не рендерим пустой padding-блок, если тело свёрнуто (children=false) */}
      {children ? <div className="p-4">{children}</div> : null}
    </div>
  )
}

export function NumberField({ label, value, onChange, suffix, min = 0, max, step = 1 }: {
  label: string; value: number; onChange: (n: number) => void; suffix?: string
  min?: number; max?: number; step?: number
}) {
  // Черновик строки позволяет свободно печатать; коммитим с валидацией на blur/Enter.
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = (raw: string) => {
    const n = clampInt(raw === '' ? min : raw, min, max)
    onChange(n)
    setDraft(String(n))
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        {suffix && <span className="rounded bg-elevated px-1.5 text-xs font-bold text-spark-300">{suffix}</span>}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => commit(String(value - step))} className="btn-icon h-9 w-9">−</button>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          // Клик выделяет значение: иначе ввод дописывается к нулю — «012» вместо «12».
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => { if (/^\d*$/.test(e.target.value)) setDraft(e.target.value) }}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(draft) } }}
          className="input h-9 text-center"
        />
        <button type="button" onClick={() => commit(String(value + step))} className="btn-icon h-9 w-9">+</button>
      </div>
    </div>
  )
}

/** Пара min/max в одну строку (feature 4). */
export function MinMaxField({ label, min, max, onMin, onMax, suffix, hardMax }: {
  label: string; min: number; max: number; onMin: (n: number) => void; onMax: (n: number) => void
  suffix?: string; hardMax?: number
}) {
  const invalid = min > 0 && max > 0 && min > max
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        {suffix && <span className="rounded bg-elevated px-1.5 text-xs font-bold text-spark-300">{suffix}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Мин." value={min} onChange={onMin} max={hardMax} />
        <NumberField label="Макс." value={max} onChange={onMax} max={hardMax} />
      </div>
      {invalid && <p className="mt-1 text-xs text-rose-300">Минимум не должен превышать максимум</p>}
    </div>
  )
}

export function ToggleRow({ icon, label, checked, onChange }: {
  icon: React.ReactNode; label: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
      <span className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="text-spark-400">{icon}</span> {label}
      </span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  )
}

export function LaunchStat({ icon, color, label, value, warn }: {
  icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}20`, color }}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
        <div className={cn('font-display text-lg font-bold', warn ? 'text-amber-400' : 'text-fg')}>{value}</div>
      </div>
    </div>
  )
}

export function DelayFields({ label, from, to, onFrom, onTo, unit }: {
  label: string; from: number; to: number; onFrom: (n: number) => void; onTo: (n: number) => void; unit?: string
}) {
  const u = unit ? ` ${unit}` : ''
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3 last:border-0 last:pb-0">
      <span className="text-sm font-medium text-fg">{label}</span>
      <div className="flex items-center gap-2">
        {/* #9: «от» не больше «до», «до» не меньше «от» — макс/мин связаны */}
        <Stepper value={from} onChange={onFrom} suffix={u} max={to} />
        <span className="text-muted">до</span>
        <Stepper value={to} onChange={onTo} suffix={u} min={from} />
      </div>
    </div>
  )
}

function Stepper({ value, onChange, suffix, min = 0, max }: {
  value: number; onChange: (n: number) => void; suffix?: string; min?: number; max?: number
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = (raw: string) => {
    const n = clampInt(raw === '' ? min : raw, min, max)
    onChange(n)
    setDraft(String(n))
  }
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-line bg-elevated">
      <button type="button" onClick={() => commit(String(value - 1))} className="px-2.5 py-1.5 text-muted hover:text-fg">−</button>
      <div className="flex min-w-[54px] items-center justify-center gap-0.5 px-1">
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          // Клик выделяет значение: иначе ввод дописывается к нулю — «012» вместо «12».
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => { if (/^\d*$/.test(e.target.value)) setDraft(e.target.value) }}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(draft) } }}
          className="w-full min-w-0 bg-transparent text-center font-mono text-sm font-bold text-fg outline-none"
          style={{ width: `${Math.max(2, draft.length)}ch` }}
        />
        {suffix && <span className="font-mono text-sm font-bold text-muted">{suffix}</span>}
      </div>
      <button type="button" onClick={() => commit(String(value + 1))} className="px-2.5 py-1.5 text-muted hover:text-fg">+</button>
    </div>
  )
}

export function SingleDelayField({ label, value, onChange, unit }: {
  label: string; value: number; onChange: (n: number) => void; unit?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3 last:border-0 last:pb-0">
      <span className="text-sm font-medium text-fg">{label}</span>
      <Stepper value={value} onChange={onChange} suffix={unit ? ` ${unit}` : ''} />
    </div>
  )
}
