import { useState } from 'react'
import { Shield, Settings2, Bolt, HelpCircle, ChevronDown } from 'lucide-react'
import { Badge, Switch } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { PROTECTION_STEPS } from '@/shared/config/protectionInfo'

const LEVELS = [
  {
    label: 'Консервативный',
    desc: 'Макс. задержки, низкая частота',
    icon: Shield,
    tooltip:
      'Самый безопасный режим. Задержки увеличены ~×1.8, вероятность действия снижается до 25%. Меньше FloodWait и риска бана. Подходит для новых и дорогих аккаунтов.',
  },
  {
    label: 'Сбалансированный',
    desc: 'Рекомендуется',
    icon: Settings2,
    tooltip:
      'Оптимальный баланс скорости и безопасности. Стандартные задержки, вероятность до 45%. Рекомендуется для повседневной работы.',
  },
  {
    label: 'Агрессивный',
    desc: 'Выше скорость, выше риск',
    icon: Bolt,
    tooltip:
      'Минимальные паузы (~×0.75), максимальная частота действий. Быстрее результат, но выше шанс FloodWait, карантина или ограничений Telegram.',
  },
]

const BLOCK_TIP =
  'Автозащита аккаунтов: при FloodWait — пауза и ожидание; после нескольких FloodWait подряд аккаунт уходит в карантин. Аккаунты со статусами quarantine, spamblock, frozen и reauth пропускаются.'

function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('group/tip relative inline-flex shrink-0 align-middle', className)}>
      <HelpCircle
        size={14}
        className="cursor-help text-muted transition-colors hover:text-spark-300"
        aria-label="Подсказка"
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-50 w-56 -translate-x-1/2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-[11px] font-normal leading-snug text-muted opacity-0 shadow-xl transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {text}
        <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-line bg-surface" />
      </span>
    </span>
  )
}

export function ProtectionBlock({ enabled, onEnabled, level, onLevel }: {
  enabled: boolean; onEnabled: (v: boolean) => void; level: number; onLevel: (n: number) => void
}) {
  const [howOpen, setHowOpen] = useState(false)
  return (
    <div className="mb-4 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400">
          <Shield size={20} />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-bold text-fg">Защита аккаунтов</span>
            <Badge tone="spark">AI</Badge>
            <InfoTip text={BLOCK_TIP} />
          </div>
          <div className="text-xs text-muted">FloodWait → пауза → карантин · пропуск quarantine / spamblock / frozen</div>
        </div>
        <Switch checked={enabled} onChange={onEnabled} />
      </div>
      {enabled && (
        <div className="mt-4 grid gap-2 border-t border-spark-500/20 pt-4 sm:grid-cols-3">
          {LEVELS.map((lvl, i) => {
            const Icon = lvl.icon
            return (
              <button
                key={lvl.label}
                type="button"
                onClick={() => onLevel(i)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all',
                  i === level ? 'border-spark-500/60 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30',
                )}
              >
                <span
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                    i === level ? 'bg-spark-500/20 text-spark-300' : 'text-muted',
                  )}
                  title={lvl.label}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-sm font-bold', i === level ? 'text-fg' : 'text-muted')}>{lvl.label}</span>
                    <InfoTip text={lvl.tooltip} />
                  </div>
                  <div className="text-[11px] text-muted">{lvl.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
      <div className="mt-3 border-t border-spark-500/20 pt-3">
        <button
          type="button"
          onClick={() => setHowOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 text-left text-xs font-bold uppercase tracking-wide text-spark-300"
        >
          <ChevronDown size={14} className={cn('transition-transform', !howOpen && '-rotate-90')} />
          Как работает защита
        </button>
        {howOpen && (
          <ul className="mt-2 space-y-2">
            {PROTECTION_STEPS.map((s) => (
              <li key={s.title} className="rounded-xl border border-line bg-elevated/50 p-2.5">
                <div className="text-xs font-bold text-fg">{s.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{s.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export { InfoTip }
