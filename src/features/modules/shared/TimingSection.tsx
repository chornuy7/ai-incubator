import { useState } from 'react'
import { Timer, Bolt, Settings2, Shield, ChevronRight } from 'lucide-react'
import { ToggleGroup } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { SectionCard, NumberField, MinMaxField, DelayFields, SingleDelayField } from './index'
import { InfoTip } from './ProtectionBlock'

export interface DelaysShape {
  comment: [number, number]
  action: [number, number]
  join: [number, number]
  floodWait: number
  floodQuarantine: number
}

interface MinMaxCtl { min: number; max: number; onMin: (n: number) => void; onMax: (n: number) => void }

export interface TimingSectionProps {
  /** Переключатель режима работы (например ['По количеству','По времени']). */
  workModeOptions?: string[]
  workMode?: number
  onWorkMode?: (n: number) => void
  workModeLabel?: string

  /** Длительность в минутах (для режима «по времени» или показывать всегда). */
  durationMinutes?: number
  onDuration?: (n: number) => void
  showDurationAlways?: boolean
  durationPeriodHint?: string

  /** Общий лимит действий (min/max). */
  totalLabel?: string
  total?: MinMaxCtl | null
  /** Если задан — «Всего» не редактируется, а считается авто = на-аккаунт × число аккаунтов (§3.5). */
  computedTotal?: { value: number; accounts: number } | null
  /** Лимит на аккаунт (min/max). */
  perAccount?: MinMaxCtl | null
  /** Мин. слов в посте. */
  minWords?: { value: number; onChange: (n: number) => void } | null

  /** Задержки. */
  delays: DelaysShape
  onDelays: (updater: (d: DelaysShape) => DelaysShape) => void
  showComment?: boolean
  showAction?: boolean
  showJoin?: boolean
  labels?: { comment?: string; action?: string; join?: string }

  delayPresets?: string[]
  delayPreset?: number
  onDelayPreset?: (n: number) => void
}

// §3.2 (MR-103): пресет темпа выбирается карточками — единый визуальный язык с «Защитой»
// (Консервативный/Сбалансированный/Агрессивный). Описания по индексу: 0 — минимальные
// задержки (быстрее), 1 — рекомендуемо, 2 — максимальные задержки (безопаснее).
const PRESET_META = [
  {
    desc: 'Минимальные задержки — быстрее, выше риск', icon: Bolt,
    tooltip: 'Множитель пауз ~×0.75. Действия идут чаще и быстрее — результат раньше, но выше шанс FloodWait, карантина и ограничений Telegram. Подходит для прогретых, «расходных» аккаунтов.',
  },
  {
    desc: 'Оптимальный баланс — по умолчанию', icon: Settings2,
    tooltip: 'Стандартные задержки (×1). Оптимальный баланс скорости и безопасности — рекомендуется для повседневной работы.',
  },
  {
    desc: 'Максимальные задержки — безопаснее, медленнее', icon: Shield,
    tooltip: 'Множитель пауз ~×1.8. Максимальные интервалы между действиями — медленнее, зато минимум FloodWait и риска бана. Подходит для новых и дорогих аккаунтов.',
  },
]

/**
 * (3) Единая секция «Тайминги и задержки»: сверху — пресет темпа карточками (как «Защита»),
 * а точная настройка (режим работы, лимиты, задержки) спрятана под «Расширенные настройки»,
 * чтобы по умолчанию хватало одного выбора Мин/Рекомендуемые/Макс. Все числовые поля
 * поддерживают ручной ввод (NumberField/Stepper).
 */
export function TimingSection(props: TimingSectionProps) {
  const {
    workModeOptions, workMode = 0, onWorkMode, workModeLabel = 'Режим работы',
    durationMinutes = 60, onDuration, showDurationAlways, durationPeriodHint,
    totalLabel = 'Действия', total, computedTotal, perAccount, minWords,
    delays, onDelays, showComment, showAction = true, showJoin = true, labels = {},
    delayPresets, delayPreset = 1, onDelayPreset,
  } = props

  const hasPresets = !!(delayPresets && onDelayPreset)
  // Нет пресета темпа — раскрываем детали сразу (иначе всё окажется спрятано ни за чем).
  const [advanced, setAdvanced] = useState(!hasPresets)

  const timeMode = !!workModeOptions && workMode === 1
  const showDuration = showDurationAlways || timeMode
  const showCounts = !workModeOptions || !timeMode

  return (
    <SectionCard icon={<Timer size={18} />} title="Тайминги и задержки">
      {/* Пресет темпа — карточками, как «Защита аккаунтов». */}
      {hasPresets && (
        <div className="grid gap-2 sm:grid-cols-3">
          {delayPresets!.map((label, i) => {
            const meta = PRESET_META[i] ?? PRESET_META[1]
            const Icon = meta.icon
            const active = i === delayPreset
            return (
              <button
                key={label}
                type="button"
                onClick={() => onDelayPreset!(i)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all',
                  active ? 'border-spark-500/60 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30',
                )}
              >
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', active ? 'bg-spark-500/20 text-spark-300' : 'text-muted')}>
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  {/* §8: у каждого пресета — маленькая подсказка «?», как у режимов «Защиты». */}
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-sm font-bold', active ? 'text-fg' : 'text-muted')}>{label}</span>
                    {meta.tooltip && <InfoTip text={meta.tooltip} />}
                  </div>
                  <div className="text-[11px] leading-snug text-muted">{meta.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Расширенные настройки — режим работы, лимиты, точные задержки. */}
      {hasPresets && (
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-muted transition-colors hover:text-fg"
        >
          <ChevronRight size={15} className={cn('transition-transform', advanced && 'rotate-90')} />
          Расширенные настройки
        </button>
      )}

      {advanced && (
        <div className={cn('space-y-4', hasPresets && 'mt-3')}>
          {/* Режим работы + лимиты */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              {workModeOptions && onWorkMode && (
                <ToggleGroup label={workModeLabel} options={workModeOptions} value={workMode} onChange={onWorkMode} />
              )}
              {showDuration && onDuration && (
                <div>
                  <NumberField label="Длительность (мин)" value={durationMinutes} onChange={onDuration} suffix={`${durationMinutes}m`} />
                  {durationPeriodHint && <p className="mt-1 text-xs text-muted">{durationPeriodHint}</p>}
                </div>
              )}
              {showCounts && computedTotal ? (
                <div>
                  <div className="mb-1 text-sm text-muted">{totalLabel} — авто</div>
                  <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                    <div className="font-display text-lg font-bold text-fg">≈ {computedTotal.value}</div>
                    <div className="text-[11px] text-muted">на 1 аккаунт × {computedTotal.accounts} акк.</div>
                  </div>
                  {computedTotal.accounts <= 1 && (
                    <p className="mt-1 text-[11px] text-amber-300">Выбран 1 аккаунт — вся нагрузка ляжет на него. Добавьте аккаунты, чтобы распределить.</p>
                  )}
                </div>
              ) : showCounts && total ? (
                <MinMaxField label={totalLabel} min={total.min} max={total.max} onMin={total.onMin} onMax={total.onMax} />
              ) : null}
            </div>

            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              {perAccount && (
                <MinMaxField label={computedTotal ? 'Сколько сделает 1 аккаунт для цели' : 'На аккаунт'} min={perAccount.min} max={perAccount.max} onMin={perAccount.onMin} onMax={perAccount.onMax} />
              )}
              {minWords && (
                <NumberField label="Мин. слов в посте" value={minWords.value} onChange={minWords.onChange} />
              )}
              {!perAccount && !minWords && (
                <p className="text-sm text-muted">Лимиты применяются на сервере с учётом защиты аккаунтов.</p>
              )}
            </div>
          </div>

          {/* Задержки */}
          <div className="rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-2 text-sm font-bold text-fg">Задержки</div>
            <div className="space-y-3">
              {showComment && delays.comment && (
                <DelayFields
                  label={labels.comment ?? 'Задержка комментария'}
                  from={delays.comment[0]} to={delays.comment[1]}
                  onFrom={(n) => onDelays((d) => ({ ...d, comment: [n, d.comment?.[1] ?? n] }))}
                  onTo={(n) => onDelays((d) => ({ ...d, comment: [d.comment?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              {showAction && delays.action && (
                <DelayFields
                  label={labels.action ?? 'Задержка действия'}
                  from={delays.action[0]} to={delays.action[1]}
                  onFrom={(n) => onDelays((d) => ({ ...d, action: [n, d.action?.[1] ?? n] }))}
                  onTo={(n) => onDelays((d) => ({ ...d, action: [d.action?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              {showJoin && delays.join && (
                <DelayFields
                  label={labels.join ?? 'Задержка вступления'}
                  from={delays.join[0]} to={delays.join[1]}
                  onFrom={(n) => onDelays((d) => ({ ...d, join: [n, d.join?.[1] ?? n] }))}
                  onTo={(n) => onDelays((d) => ({ ...d, join: [d.join?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              <SingleDelayField label="FloodWait задержка (сек)" value={delays.floodWait} onChange={(n) => onDelays((d) => ({ ...d, floodWait: n }))} unit="с" />
              <SingleDelayField label="FloodWait до карантина" value={delays.floodQuarantine} onChange={(n) => onDelays((d) => ({ ...d, floodQuarantine: n }))} />
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
