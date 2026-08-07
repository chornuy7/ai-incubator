import { Play, Save, AlertTriangle, Loader2, Bookmark, X, ArrowUpRight } from 'lucide-react'
import type { ModuleTask, ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { cn } from '@/shared/lib/utils'
import { FloatingBar } from './FloatingBar'
import { presetHex } from './SavePresetModal'

export function LaunchPanel({
  running, starting, canStart, onStart, onSave, primaryLabel, stats, warn, cost,
  presets, onApplyPreset, onDeletePreset, extras, steps, blockedBy = [],
}: {
  running: boolean; starting: boolean; canStart: boolean
  onStart: () => void; onStop?: () => void; onSave: () => void
  primaryLabel: string
  /** Компактные шаги запуска — строкой ПОД кнопкой, внутри самой панели. */
  steps?: React.ReactNode
  /** Что мешает запуску: показываем рядом с серой кнопкой, чтобы не гадать. */
  blockedBy?: string[]
  stats: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }[]
  task: ModuleTask | null
  warn?: string
  /** §5.1: во сколько обойдётся запуск — показываем ДО кнопки, а не по факту списания. */
  cost?: React.ReactNode
  presets?: ModulePreset[]
  onApplyPreset?: (settings: ModuleTaskSettings) => void
  onDeletePreset?: (id: string) => void
  /**
   * Доп. блоки запуска (расписание, ссылка на логи). Рендерятся В ПОТОКЕ, ПЕРЕД плавающим
   * баром: сам бар обязан быть последним элементом, иначе его заглушка резервирует место
   * в середине, а бар висит внизу экрана поверх этого контента — та самая «двойная плашка».
   */
  extras?: React.ReactNode
}) {
  return (
    <>
      {onApplyPreset && presets && presets.length > 0 && (
        <div className="mb-3 rounded-2xl border border-line bg-elevated/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
            <Bookmark size={13} /> Мои шаблоны
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <span
                key={p.id}
                className="group inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface pl-2.5 pr-1.5 py-1.5 text-sm font-medium text-fg transition-colors hover:border-spark-500/40"
                style={{ borderLeft: `3px solid ${presetHex(p.color)}` }}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: presetHex(p.color) }} />
                <button
                  type="button"
                  onClick={() => onApplyPreset(p.settings)}
                  disabled={running}
                  title="Применить шаблон к настройкам"
                  className="max-w-[180px] truncate text-left disabled:opacity-50"
                >
                  {p.name}
                </button>
                {p.owner && (
                  <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Владелец шаблона">
                    {p.owner}
                  </span>
                )}
                {onDeletePreset && (
                  <button
                    type="button"
                    onClick={() => onDeletePreset(p.id)}
                    title="Удалить шаблон"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-faint hover:bg-rose-500/12 hover:text-rose-300"
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Клик по названию — подставить сохранённые настройки. Выбор аккаунтов не меняется.</p>
        </div>
      )}
      {extras}
      {/* Плавающий бар — ПОСЛЕДНИЙ элемент: его заглушка резервирует место в самом низу
          карточки, ничего не рендерится ниже, и бар чисто «отрывается» ко дну экрана. */}
      {/* §4 (UI-001): раскладка нижней панели по решению созвона — ШАБЛОН слева,
          параметры/навигация (шаги + чего не хватает) по ЦЕНТРУ, кнопка «Начать» справа
          (с запасом под плавающие виджеты). */}
      {/* Вся сводка запуска — В САМОЙ ПАНЕЛИ, компактными чипами: раньше она жила
          широкими плитками выше по странице, и до кнопки «Начать» приходилось помнить,
          что там было. Панель держим узкой: две строки, мелкий шрифт, детали — в
          подсказках. Кнопки «Сохранить шаблон» и «Начать» стоят рядом справа. */}
      <FloatingBar>
        <div className="grid w-full grid-cols-1 items-center gap-x-4 gap-y-1.5 sm:grid-cols-[1fr_auto]">
          {/* Слева — сводка и навигация */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted sm:justify-start">
              {stats.map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1" title={s.label}>
                  <span className={cn('shrink-0', s.color)}>{s.icon}</span>
                  <span className="uppercase tracking-wide">{s.label}</span>
                  <b className={cn('font-semibold', s.warn ? 'text-amber-300' : 'text-fg')}>{s.value}</b>
                </span>
              ))}
              {!running && cost}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 sm:justify-start">
              {steps}
              {!running && (blockedBy.length > 0 || warn) && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                  <AlertTriangle size={12} className="shrink-0" />
                  {blockedBy.length ? `Осталось: ${blockedBy.join(' · ')}` : warn}
                </span>
              )}
            </div>
          </div>
          {/* Справа — «Сохранить шаблон» и «Начать» рядом */}
          <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end sm:pr-14">
            {running && (
              <a href="/panel/tasks" className="btn-ghost h-10 text-sm" title="Управление, прогресс и логи — в Дашборде задач"><ArrowUpRight size={15} /> В Дашборде задач</a>
            )}
            <button type="button" onClick={onSave} className="btn-ghost h-10 text-sm"><Save size={15} /> Сохранить шаблон</button>
            <button
              type="button"
              onClick={onStart}
              disabled={starting || !canStart}
              title={!canStart && blockedBy.length ? `Осталось: ${blockedBy.join('; ')}` : undefined}
              className="btn-primary h-10 min-w-[150px]"
            >
              {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {primaryLabel}
            </button>
          </div>
        </div>
      </FloatingBar>
    </>
  )
}
