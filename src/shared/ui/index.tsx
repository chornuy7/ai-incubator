import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { AccountStatus } from '@/shared/types'
import { STATUS_META } from '@/mocks/store'

export { Modal } from './Modal'

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
  options, value, onChange, size = 'md', className,
}: {
  options: string[]; value: number; onChange: (i: number) => void; size?: 'sm' | 'md'; className?: string
}) {
  return (
    <div className={cn('inline-flex flex-wrap gap-1 rounded-xl border border-line bg-elevated p-1', className)}>
      {options.map((o, i) => (
        <button
          key={o + i}
          onClick={() => onChange(i)}
          className={cn(
            'rounded-lg font-semibold transition-all',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            i === value ? 'bg-spark-gradient text-[#04150c] shadow-sm' : 'text-muted hover:text-fg',
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
      <span className="label">{label}</span>
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
export function StatusBadge({ status }: { status: AccountStatus }) {
  const m = STATUS_META[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', m.bg, m.text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  )
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
}

export function Select({
  options, value, onChange, className, placeholder,
}: {
  options: SelectOption[]; value: string; onChange: (v: string) => void; className?: string; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const current = options.find((o) => o.value === value)

  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect()
      setCoords({ top: r.bottom + 6, left: r.left, width: r.width })
    }
    setOpen((v) => !v)
  }

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
            className="fixed z-[120] max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop animate-scale-in"
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  o.value === value ? 'bg-spark-500/12 text-spark-300' : 'text-fg hover:bg-elevated',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check size={15} className="shrink-0" />}
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
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
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
