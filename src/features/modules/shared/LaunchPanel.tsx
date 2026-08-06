import { Play, Save, AlertTriangle, Loader2, Bookmark, X, ArrowUpRight } from 'lucide-react'
import type { ModuleTask, ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { LaunchStat } from './index'
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
      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {stats.map((s) => <LaunchStat key={s.label} {...s} />)}
      </div>
      {!running && cost}
      {warn && !running && (
        <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
          <AlertTriangle size={18} className="text-rose-400" />
          <div className="text-sm text-rose-300">{warn}</div>
        </div>
      )}
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
      {/* Внутри панели — три колонки одной ширины: кнопка строго по центру панели,
          «Сохранить шаблон» прижат вправо (с запасом под плавающие виджеты). Под ними —
          шаги и, если запуск заблокирован, чего не хватает. */}
      <FloatingBar>
        <div className="grid w-full grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <span className="hidden sm:block" />
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onStart}
              disabled={starting || !canStart}
              title={!canStart && blockedBy.length ? `Осталось: ${blockedBy.join('; ')}` : undefined}
              className="btn-primary h-11 min-w-[180px]"
            >
              {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {primaryLabel}
            </button>
            {running && (
              <a href="/panel/tasks" className="btn-ghost h-11 text-sm" title="Управление, прогресс и логи — в Дашборде задач"><ArrowUpRight size={15} /> В Дашборде задач</a>
            )}
          </div>
          <div className="flex justify-center sm:justify-end sm:pr-14">
            <button type="button" onClick={onSave} className="btn-ghost h-11 text-sm"><Save size={15} /> Сохранить шаблон</button>
          </div>
        </div>
        {/* Кнопка серая — сразу видно, что осталось заполнить (а не догадываться). */}
        {!running && blockedBy.length > 0 && (
          <div className="flex items-center gap-1.5 text-center text-[11px] text-amber-300">
            <AlertTriangle size={12} className="shrink-0" />
            <span>Осталось: {blockedBy.join(' · ')}</span>
          </div>
        )}
        {steps}
      </FloatingBar>
    </>
  )
}
