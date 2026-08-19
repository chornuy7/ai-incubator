import { Settings2, Shield, SlidersHorizontal, Gauge, Zap } from 'lucide-react'
import { SectionCard, HelpButton } from './index'
import { InfoTip } from './ProtectionBlock'
import { Switch } from '@/shared/ui'
import { TimingSection, type TimingSectionProps } from './TimingSection'
import { cn } from '@/shared/lib/utils'

/**
 * «Защита и тайминги» — ОДИН блок и ОДИН ряд пресетов на все модули (правка 19.08).
 *
 * До этого выбор темпа спрашивали дважды: тремя карточками в «Защите аккаунтов»
 * (Консервативный/Сбалансированный/Агрессивный) и четырьмя в «Таймингах» (тот же набор
 * задом наперёд плюс Custom). Хуже, чем просто дубль: сервер перемножал оба множителя
 * (`delayMultiplier` = LEVEL_MUL[protectionLevel] × PRESET_MUL[delayPreset]), поэтому
 * «консервативный» в обоих рядах давал ×3.24 — вдвое осторожнее, чем обещала каждая из
 * двух подписей, и никакой экран этого не показывал.
 *
 * Теперь ряд один. Он пишет `protectionLevel` (это и политика защиты, и множитель пауз),
 * а `delayPreset` держит нейтральным, чтобы множитель не удваивался:
 *   Консервативный → level 0 (×1.8) · Сбалансированный → 1 (×1) · Агрессивный → 2 (×0.75)
 *   Custom         → delayPreset 3: задержки применяются ровно как введены (×1)
 */
const PRESETS = [
  { label: 'Консервативный', desc: 'Макс. задержки, безопаснее', icon: Shield, tooltip: 'Задержки ×1.8 и пониженная вероятность действия. Для новых и дорогих аккаунтов.' },
  { label: 'Сбалансированный', desc: 'Рекомендуется', icon: Gauge, tooltip: 'Базовые задержки без масштабирования — режим по умолчанию.' },
  { label: 'Агрессивный', desc: 'Выше скорость, выше риск', icon: Zap, tooltip: 'Задержки ×0.75: быстрее, но выше шанс FloodWait и спам-фильтра.' },
  { label: 'Custom', desc: 'Ручные значения задержек', icon: SlidersHorizontal, tooltip: 'Свои задержки: работает ровно то, что задано в «Расширенных настройках», без масштабирования.' },
]
const CUSTOM = 3
/** Множители пауз по уровню защиты — зеркало LEVEL_MUL из server/lib/protection.js. */
const LEVEL_MUL = [1.8, 1, 0.75]

export function ProtectionTimings({
  enabled, onEnabled, level, onLevel, badge, timing, children,
}: {
  enabled: boolean
  onEnabled: (v: boolean) => void
  level: number
  onLevel: (n: number) => void
  badge?: string
  /** Параметры таймингов. Не переданы — блок рисуется без них (парсеры со своими полями). */
  timing?: TimingSectionProps
  children?: React.ReactNode
}) {
  const preset = timing?.delayPreset
  const onPreset = timing?.onDelayPreset
  // Какая карточка подсвечена: Custom узнаём по delayPreset = 3, иначе по уровню защиты.
  const active = preset === CUSTOM ? CUSTOM : level
  const pick = (i: number) => {
    if (i === CUSTOM) { onPreset?.(CUSTOM); return }
    onLevel(i)
    // Нейтральный пресет: множитель задержек берётся только из уровня защиты.
    onPreset?.(1)
  }
  const mul = active === CUSTOM ? 1 : (LEVEL_MUL[level] ?? 1)

  return (
    <SectionCard icon={<Settings2 size={18} />} title="Защита и тайминги" badge={badge}>
      {/* Зелёная карточка «Защита аккаунтов» убрана (правка 19.08): она занимала пол-экрана
          ради переключателя и ссылки, а сам выбор — вот он, рядом карточками. Осталась
          компактная строка с тем же переключателем и той же ссылкой в Help Center. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-fg">
          <Shield size={15} className="text-spark-300" /> Защита аккаунтов
          <HelpButton topic="Защита аккаунтов" />
        </span>
        <span className="text-xs text-muted">FloodWait → пауза → карантин · пропуск quarantine / spamblock / frozen</span>
        <span className="ml-auto"><Switch checked={enabled} onChange={onEnabled} /></span>
      </div>

      {timing && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p, i) => {
            const Icon = p.icon
            const on = i === active
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => pick(i)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all',
                  on ? 'border-spark-500/60 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30',
                )}
              >
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', on ? 'bg-spark-500/20 text-spark-300' : 'text-muted')}>
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-sm font-bold', on ? 'text-fg' : 'text-muted')}>{p.label}</span>
                    <InfoTip text={p.tooltip} />
                  </div>
                  <div className="text-[11px] text-muted">{p.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {children}

      {/* Только задержки: лимиты («сколько сделает аккаунт») живут в «Параметрах и лимитах». */}
      {timing && <TimingSection {...timing} bare part="delays" hidePresets mulOverride={mul} />}
    </SectionCard>
  )
}
