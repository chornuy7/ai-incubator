import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, AlertTriangle } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { AccountStatus } from '@/shared/types'
import { STATUS_META } from '@/mocks/store'

export { Modal } from './Modal'
export { NumberField } from './NumberField'

/* ── Card ── */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card p-5', className)}>{children}</div>
}

/* ── PageHeader ── */
export function PageHeader({
  title, subtitle, badge, icon, actions,
}: {
  title: string; subtitle?: string; badge?: string; icon?: ReactNode; actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-elevated text-spark-400">
            {icon}
          </div>
        )}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-bold tracking-tight text-fg">{title}</h1>
            {badge && (
              <span className="rounded-md bg-iris-500/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-iris-300">
                {badge}
              </span>
            )}
          </div>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ── Segmented ── */
export function Segmented({
  options, value, onChange, size = 'md', className, disabled = false,
}: {
  options: string[]; value: number; onChange: (i: number) => void; size?: 'sm' | 'md'; className?: string
  /** Заблокировать переключение (напр. пока грузятся данные выбранного варианта). */
  disabled?: boolean
}) {
  return (
    <div className={cn('inline-flex flex-wrap gap-1 rounded-xl border border-line bg-elevated p-1', className)}>
      {options.map((o, i) => (
        <button
          key={o + i}
          type="button"
          disabled={disabled}
          onClick={() => onChange(i)}
          className={cn(
            'rounded-lg font-semibold transition-all',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            i === value ? 'bg-spark-gradient text-[#04150c] shadow-sm' : 'text-muted hover:text-fg',
            disabled && 'cursor-not-allowed',
            disabled && i !== value && 'opacity-40', // текущий остаётся ярким, остальные гаснут
          )}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

/* ── ToggleGroup (labeled) ── */
export function ToggleGroup({
  label, options, value, onChange,
}: {
  label: string; options: string[]; value: number; onChange: (i: number) => void
}) {
  return (
    <div>
      {/* Пустая подпись — легальный случай: группа идёт вторым рядом под общим
          заголовком. Раньше рисовался пустой `label` и съедал вертикальный отступ. */}
      {label ? <span className="label">{label}</span> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button
            key={o + i}
            onClick={() => onChange(i)}
            className={cn(
              'rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all',
              i === value
                ? 'border-spark-500/50 bg-spark-500/12 text-spark-300'
                : 'border-line bg-elevated text-muted hover:border-spark-500/30 hover:text-fg',
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Switch ── */
export function Switch({
  checked, onChange, label, desc,
}: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; desc?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      {(label || desc) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-semibold text-fg">{label}</span>}
          {desc && <span className="block text-xs text-muted">{desc}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-spark-500' : 'bg-line',
        )}
      >
        <span
          className={cn(
            'inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
          style={{ height: 18, width: 18 }}
        />
      </button>
    </label>
  )
}

/* ── Chip ── */
export function Chip({
  active, onClick, children, className,
}: {
  active?: boolean; onClick?: () => void; children: ReactNode; className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn('chip', active ? 'chip-active' : 'text-muted hover:text-fg', className)}
    >
      {children}
    </button>
  )
}

/* ── Badge ── */
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }) {
  const tones: Record<string, string> = {
    spark: 'bg-spark-500/12 text-spark-300 border-spark-500/30',
    iris: 'bg-iris-500/12 text-iris-300 border-iris-500/30',
    amber: 'bg-amber-500/12 text-amber-300 border-amber-500/30',
    rose: 'bg-rose-500/12 text-rose-300 border-rose-500/30',
    muted: 'bg-elevated text-muted border-line',
  }
  return <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold', tones[tone])}>{children}</span>
}

/* ── Avatar ── */
export function Avatar({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  const initials = name.replace(/[@_·]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </div>
  )
}

/* ── StatusBadge ── */
/**
 * @param until срок временного статуса (спамблок/флудвейт/карантин). Когда он есть,
 *   в бейдж дописывается остаток — иначе оператор видит «спамблок» и не понимает,
 *   ждать ему или списывать аккаунт. Такие статусы система снимает сама.
 */
/**
 * Правка 14.08 (§3/MR-162): единый КАСТОМНЫЙ тултип вместо нативного title. Рендерит
 * тёмную всплывашку порталом в body (position: fixed) — таблицы и карточки часто живут в
 * контейнерах overflow-*, которые обрезали бы обычную absolute-подсказку. Позицию считаем
 * на наведении. Возвращает пропсы-триггер для целевого элемента и узел-портал.
 */
export function useTooltip<T extends HTMLElement = HTMLElement>(text?: string) {
  const ref = useRef<T | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const onMouseEnter = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r && text) setPos({ x: r.left + r.width / 2, y: r.top })
  }
  const onMouseLeave = () => setPos(null)
  const node = pos && text
    ? createPortal(
      <span
        role="tooltip"
        style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)' }}
        className="pointer-events-none z-[200] w-max max-w-[280px] whitespace-pre-line rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium normal-case leading-snug text-fg shadow-xl"
      >{text}</span>,
      document.body,
    )
    : null
  return { ref, onMouseEnter, onMouseLeave, node }
}

/**
 * Обёртка-подсказка: тёмная всплывашка вместо нативного `title` (широкая жёлтая плашка
 * браузера выглядит чужеродно и режет длинный текст). Построена на useTooltip, поэтому
 * рендерится порталом и не обрезается контейнерами overflow-*.
 *
 * Правка 20.08: заказчик просил, чтобы подсказки ВЕЗДЕ выглядели одинаково — как в
 * менеджере аккаунтов. Поэтому компонент общий, а не локальный в одной странице.
 */
export function Tip({ text, children, className }: { text?: string; children: ReactNode; className?: string }) {
  const t = useTooltip<HTMLSpanElement>(text)
  if (!text) return <>{children}</>
  return (
    <span ref={t.ref} onMouseEnter={t.onMouseEnter} onMouseLeave={t.onMouseLeave} className={cn('inline-flex', className)}>
      {children}
      {t.node}
    </span>
  )
}

export function StatusBadge({ status, until, reason }: { status: AccountStatus; until?: number | null; reason?: string }) {
  const m = STATUS_META[status]
  const left = until && until > Date.now() ? formatLeft(until - Date.now()) : ''
  const tip = [reason, until && until > Date.now() ? `Снимется автоматически ${new Date(until).toLocaleString('ru-RU')}` : ''].filter(Boolean).join(' · ')
  const t = useTooltip<HTMLSpanElement>(tip || undefined)
  return (
    <span
      ref={t.ref}
      onMouseEnter={t.onMouseEnter}
      onMouseLeave={t.onMouseLeave}
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', m.bg, m.text)}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
      {left && <span className="font-normal opacity-70">· ещё {left}</span>}
      {t.node}
    </span>
  )
}

/**
 * MR-131: «зона риска» с конкретикой. Показываем рядом со статусом, когда аккаунт под
 * угрозой (мёртвый/нет прокси, спамблок, низкий trust). Тултип перечисляет ПРИЧИНЫ с
 * последствием и сроком — чтобы не было абстрактного «повышенный риск».
 */
export function RiskBadge({ risk, compact }: {
  risk?: { level: 'none' | 'low' | 'medium' | 'high'; factors: { kind: string; text: string }[] }
  compact?: boolean
}) {
  if (!risk || risk.level === 'none' || !risk.factors.length) return null
  const tone = risk.level === 'high'
    ? 'border-rose-500/40 bg-rose-500/12 text-rose-300'
    : risk.level === 'medium'
      ? 'border-amber-500/40 bg-amber-500/12 text-amber-300'
      : 'border-slate-500/40 bg-slate-500/12 text-slate-300'
  const label = risk.level === 'high' ? 'Зона риска' : risk.level === 'medium' ? 'Риск' : 'Внимание'
  const t = useTooltip<HTMLSpanElement>(risk.factors.map((f) => `• ${f.text}`).join('\n'))
  return (
    <span
      ref={t.ref}
      onMouseEnter={t.onMouseEnter}
      onMouseLeave={t.onMouseLeave}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold', tone)}
    >
      <AlertTriangle size={12} />
      {!compact && label}
      {t.node}
    </span>
  )
}

/** Остаток времени коротко: «2 ч», «40 мин». Секунды оператору не нужны. */
function formatLeft(ms: number): string {
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min} мин`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} ч`
  return `${Math.round(h / 24)} дн`
}

/* ── EmptyState ── */
export function EmptyState({
  icon, title, desc, action,
}: {
  icon?: ReactNode; title: string; desc?: string; action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && (
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-line bg-elevated text-faint">{icon}</div>
      )}
      <div>
        <p className="font-display text-base font-bold text-fg">{title}</p>
        {desc && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{desc}</p>}
      </div>
      {action}
    </div>
  )
}

/* ── Skeleton ── */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />
}

/* ── Tabs (underline) ── */
export function Tabs({
  tabs, value, onChange, className,
}: {
  tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void; className?: string
}) {
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-line no-scrollbar', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'relative whitespace-nowrap px-4 py-2.5 text-sm font-semibold transition-colors',
            value === t.key ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {value === t.key && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-spark-gradient" />}
        </button>
      ))}
    </div>
  )
}

/* ── Select / Dropdown ── */
export interface SelectOption {
  value: string
  label: ReactNode
  /** Нельзя выбрать (например мёртвый прокси): гасим и не даём кликнуть. */
  disabled?: boolean
}

export function Select({
  options, value, onChange, className, placeholder, searchable,
}: {
  options: SelectOption[]; value: string; onChange: (v: string) => void; className?: string; placeholder?: string
  /** Поле поиска над списком. Нужно там, где вариантов десятки: языки, страны. */
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // Опции рендерятся в портале (вне ref) — не закрываем, если клик по ним,
      // иначе mousedown закроет меню раньше, чем сработает выбор опции.
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Позиционируем меню под кнопкой и держим привязку при скролле/resize (fixed-портал
  // иначе «плавает» при прокрутке). Флип вверх, если снизу не хватает места.
  useEffect(() => {
    if (!open) return
    const reposition = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const menuH = Math.min(menuRef.current?.offsetHeight ?? 288, 288)
      const spaceBelow = window.innerHeight - r.bottom
      const openUp = spaceBelow < menuH + 8 && r.top > spaceBelow
      setCoords({ top: openUp ? Math.max(8, r.top - menuH - 6) : r.bottom + 6, left: r.left, width: r.width })
    }
    reposition()
    window.addEventListener('scroll', reposition, true) // capture — ловим скролл любого контейнера
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  // Поиск без учёта регистра и по подстроке: язык ищут и как «англ», и как «english».
  // Метка — ReactNode, поэтому ищем только по текстовым: по вёрстке искать нечего,
  // и такие опции просто остаются в списке, а не пропадают из него молча.
  const q = query.trim().toLowerCase()
  const shown = searchable && q
    ? options.filter((o) => (typeof o.label === 'string' ? o.label.toLowerCase().includes(q) : true))
    : options

  const toggle = () => setOpen((v) => { if (!v) setQuery(''); return !v })

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-spark-500/30"
      >
        <span className={cn('truncate', !current && 'text-faint')}>{current?.label ?? placeholder}</span>
        <ChevronDown size={16} className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && coords &&
        createPortal(
          <div
            ref={menuRef}
            data-select-portal=""
            className="fixed z-[120] max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop animate-scale-in"
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            {searchable && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск…"
                className="mb-1 w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-spark-500/40"
                onKeyDown={(e) => {
                  // Enter выбирает первое совпадение: искать и потом ещё целиться мышью — лишнее.
                  if (e.key === 'Enter' && shown[0]) { onChange(shown[0].value); setOpen(false) }
                  if (e.key === 'Escape') setOpen(false)
                }}
              />
            )}
            {shown.length === 0 && (
              <div className="px-3 py-2 text-sm text-faint">Ничего не найдено</div>
            )}
            {shown.map((o) => (
              <button
                key={o.value}
                disabled={o.disabled}
                onClick={() => { if (o.disabled) return; onChange(o.value); setOpen(false) }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  o.disabled ? 'cursor-not-allowed text-faint opacity-50' : o.value === value ? 'bg-spark-500/12 text-spark-300' : 'text-fg hover:bg-elevated',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && !o.disabled && <Check size={15} className="shrink-0" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ── Dropdown (custom trigger + panel) ── */
export function Dropdown({
  trigger, children, align = 'right', width = 220,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (ref.current?.contains(t as Node)) return
      // клик по опции вложенного Select (портал в body) не должен закрывать Dropdown
      if (t?.closest?.('[data-select-portal]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={cn(
            'absolute z-50 mt-2 rounded-xl border border-line bg-surface p-1.5 shadow-pop animate-scale-in',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon, children, onClick, tone = 'default',
}: {
  icon?: ReactNode; children: ReactNode; onClick?: () => void; tone?: 'default' | 'danger'
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
        tone === 'danger' ? 'text-rose-300 hover:bg-rose-500/10' : 'text-fg hover:bg-elevated',
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      {children}
    </button>
  )
}
