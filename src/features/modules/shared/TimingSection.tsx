import { Timer } from 'lucide-react'
import { Segmented, ToggleGroup } from '@/shared/ui'
import { SectionCard, NumberField, MinMaxField, DelayFields, SingleDelayField } from './index'

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

/**
 * (3) Единая секция «Тайминги и задержки»: режим работы + все лимиты (min/max) + задержки
 * в одном месте. Все числовые поля поддерживают ручной ввод (NumberField/Stepper).
 */
export function TimingSection(props: TimingSectionProps) {
  const {
    workModeOptions, workMode = 0, onWorkMode, workModeLabel = 'Режим работы',
    durationMinutes = 60, onDuration, showDurationAlways, durationPeriodHint,
    totalLabel = 'Действия', total, perAccount, minWords,
    delays, onDelays, showComment, showAction = true, showJoin = true, labels = {},
    delayPresets, delayPreset = 1, onDelayPreset,
  } = props

  const timeMode = !!workModeOptions && workMode === 1
  const showDuration = showDurationAlways || timeMode
  const showCounts = !workModeOptions || !timeMode

  return (
    <SectionCard
      icon={<Timer size={18} />}
      title="Тайминги и задержки"
      right={delayPresets && onDelayPreset ? <Segmented size="sm" options={delayPresets} value={delayPreset} onChange={onDelayPreset} /> : undefined}
    >
      <div className="space-y-4">
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
            {showCounts && total && (
              <MinMaxField label={totalLabel} min={total.min} max={total.max} onMin={total.onMin} onMax={total.onMax} />
            )}
          </div>

          <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
            {perAccount && (
              <MinMaxField label="На аккаунт" min={perAccount.min} max={perAccount.max} onMin={perAccount.onMin} onMax={perAccount.onMax} />
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
    </SectionCard>
  )
}
