import { Check } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

/**
 * Шаг мастера запуска. `anchor` — id блока на странице: клик по шагу прокручивает
 * к нему («связка» шага с разделом). `optional` — необязательный шаг: показываем
 * серым пунктиром, он не мешает запуску и не становится «текущим».
 */
export interface LaunchStep {
  label: string
  done: boolean
  anchor: string
  optional?: boolean
  current?: boolean
}

/**
 * Проставить «текущий» шаг: первый невыполненный ОБЯЗАТЕЛЬНЫЙ. Не мутирует вход.
 */
export function markCurrentStep(steps: LaunchStep[]): LaunchStep[] {
  const out = steps.map((s) => ({ ...s, current: false }))
  const i = out.findIndex((s) => !s.done && !s.optional)
  if (i >= 0) out[i].current = true
  return out
}

/**
 * Компактная строка шагов — живёт в нижней панели ПОД кнопкой запуска, поэтому всё
 * видно сразу, без прокрутки к мастеру наверху страницы. Одна на все модули: и на
 * LiveModule, и на нейродиалоги, и на парсеры — чтобы поведение не разъезжалось.
 */
export function LaunchSteps({ steps }: { steps: LaunchStep[] }) {
  if (steps.length < 2) return null
  const go = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5">
          {i > 0 && (
            <span className={cn('h-px w-4 rounded-full',
              steps[i - 1].done && !steps[i - 1].optional ? 'bg-spark-500/60' : 'bg-line')} />
          )}
          <button
            type="button"
            onClick={() => go(s.anchor)}
            title={s.optional ? `${s.label} — необязательно, можно запускать без этого шага` : `Перейти к разделу «${s.label}»`}
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-opacity hover:opacity-80"
          >
            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold',
              s.optional ? 'border-dashed border-line bg-transparent text-faint'
                : s.done ? 'border-spark-500 bg-spark-500 text-[#04150c]'
                  : s.current ? 'border-spark-500 bg-spark-500/15 text-spark-200'
                    : 'border-line bg-elevated text-muted')}>
              {s.done && !s.optional ? <Check size={11} strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn('text-[11px]',
              s.optional ? 'text-faint'
                : s.current ? 'font-bold text-fg' : s.done ? 'text-spark-200' : 'text-muted')}>
              {s.label}{s.optional && <span className="ml-1 text-[10px]">(необяз.)</span>}
            </span>
          </button>
        </span>
      ))}
    </div>
  )
}
