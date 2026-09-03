import { Shield, Settings2, Bolt, HelpCircle } from 'lucide-react'
import { Switch, Tip} from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { useUi } from '@/shared/lib/uiStore'
import { cn } from '@/shared/lib/utils'

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

/** Подсказка-«?» рядом с подписью. Экспортируется: тем же видом её рисует общий
 *  ряд пресетов в «Защите и таймингах» (правка 19.08). */
export function InfoTip({ text, className }: { text: string; className?: string }) {
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

export function ProtectionBlock({ enabled, onEnabled, level, onLevel, showLevels = true, children }: {
  enabled: boolean; onEnabled: (v: boolean) => void; level: number; onLevel: (n: number) => void
  /** Рисовать ли собственный ряд из трёх уровней. */
  showLevels?: boolean
  /**
   * Что показать вместо трёх уровней. «Защита и тайминги» передаёт сюда общий ряд из
   * четырёх пресетов (правка 19.08): раньше он стоял отдельной полосой под зелёной
   * карточкой, и выбор темпа читался как настройка, не связанная с защитой — хотя это
   * ровно она и есть.
   */
  children?: React.ReactNode
}) {
  // HELP-001 (§8): «Как работает защита» больше не раскрывается инлайн-дублем —
  // и знак вопроса, и текстовая ссылка открывают одну статью Help Center в боковой панели.
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)
  const openHelp = () => { setHelpTopic('Защита аккаунтов'); setHelpOpen(true) }
  return (
    <div className="mb-4 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400">
          <Shield size={20} />
        </div>
        <div className="flex-1">
          {/* HELP-001 (§8): убраны избыточная плашка «AI» и дублирующий «?» (InfoTip) —
              рядом с «Защита аккаунтов» остаётся один знак вопроса, ведущий в Help Center. */}
          <div className="flex items-center gap-2">
            <span className="font-bold text-fg">Защита аккаунтов</span>
            <HelpButton topic="Защита аккаунтов" />
          </div>
          <div className="text-xs text-muted">FloodWait → пауза → карантин · пропуск quarantine / spamblock / frozen</div>
        </div>
        <Switch checked={enabled} onChange={onEnabled} />
      </div>
      {/* Содержимое (общий ряд пресетов) — на месте трёх уровней, внутри той же карточки. */}
      {enabled && children && (
        <div className="mt-4 border-t border-spark-500/20 pt-4">{children}</div>
      )}
      {enabled && showLevels && (
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
                <Tip
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                    i === level ? 'bg-spark-500/20 text-spark-300' : 'text-muted',
                  )}
                  text={lvl.label}
                >
                  <Icon size={16} />
                </Tip>
                <div className="min-w-0 flex-1">
                  {/* §8: маленькие подсказки у отдельных режимов оставляем. */}
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
          onClick={openHelp}
          className="text-xs font-bold uppercase tracking-wide text-spark-300 transition-colors hover:text-spark-200"
        >
          Как работает защита →
        </button>
      </div>
    </div>
  )
}

