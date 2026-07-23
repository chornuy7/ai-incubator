import { Play, Save, AlertTriangle, Loader2, Bookmark, X, ArrowUpRight } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { ModuleTask, ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { LaunchStat } from './index'
import { FloatingBar } from './FloatingBar'
import { presetHex } from './SavePresetModal'

export function LaunchPanel({
  running, starting, canStart, onStart, onSave, primaryLabel, stats, task, warn, cost,
  presets, onApplyPreset, onDeletePreset,
}: {
  running: boolean; starting: boolean; canStart: boolean
  onStart: () => void; onStop?: () => void; onSave: () => void
  primaryLabel: string
  stats: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }[]
  task: ModuleTask | null
  warn?: string
  /** §5.1: во сколько обойдётся запуск — показываем ДО кнопки, а не по факту списания. */
  cost?: React.ReactNode
  presets?: ModulePreset[]
  onApplyPreset?: (settings: ModuleTaskSettings) => void
  onDeletePreset?: (id: string) => void
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
      <FloatingBar>
        <div className="flex items-center gap-2 text-sm font-semibold text-muted">
          <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} />
          {running ? 'Выполняется' : task?.status === 'done' ? 'Завершено' : 'Готов'}
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={onStart} disabled={starting || !canStart} className="btn-primary h-11 min-w-[180px]">
            {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {primaryLabel}
          </button>
          {running && (
            <a href="/panel/tasks" className="btn-ghost h-11 text-sm" title="Управление, прогресс и логи — в Дашборде задач"><ArrowUpRight size={15} /> В Дашборде задач</a>
          )}
        </div>
        <button type="button" onClick={onSave} className="btn-ghost h-11 text-sm"><Save size={15} /> Сохранить пресет</button>
      </FloatingBar>
      {onApplyPreset && presets && presets.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-elevated/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
            <Bookmark size={13} /> Мои пресеты
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
                  title="Применить пресет к настройкам"
                  className="max-w-[180px] truncate text-left disabled:opacity-50"
                >
                  {p.name}
                </button>
                {p.owner && (
                  <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Владелец пресета">
                    {p.owner}
                  </span>
                )}
                {onDeletePreset && (
                  <button
                    type="button"
                    onClick={() => onDeletePreset(p.id)}
                    title="Удалить пресет"
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
    </>
  )
}
