import { Play, Save, Square, AlertTriangle, Loader2, Bookmark, X } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import type { ModuleTask, ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { LaunchStat } from './index'

export function LaunchPanel({
  running, starting, canStart, onStart, onStop, onSave, primaryLabel, stats, task, warn,
  presets, onApplyPreset, onDeletePreset,
}: {
  running: boolean; starting: boolean; canStart: boolean
  onStart: () => void; onStop: () => void; onSave: () => void
  primaryLabel: string
  stats: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }[]
  task: ModuleTask | null
  warn?: string
  presets?: ModulePreset[]
  onApplyPreset?: (settings: ModuleTaskSettings) => void
  onDeletePreset?: (id: string) => void
}) {
  const done = task?.progress.actionsDone ?? task?.progress.commentsSent ?? 0
  const total = task?.progress.total ?? 0
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {stats.map((s) => <LaunchStat key={s.label} {...s} />)}
      </div>
      {warn && !running && (
        <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
          <AlertTriangle size={18} className="text-rose-400" />
          <div className="text-sm text-rose-300">{warn}</div>
        </div>
      )}
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
        <div className="flex items-center gap-2 text-sm font-semibold text-muted">
          <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} />
          {running ? 'Выполняется' : task?.status === 'done' ? 'Завершено' : 'Готов'}
        </div>
        <div className="flex flex-1 justify-center gap-2">
          {running ? (
            <button type="button" onClick={onStop} className="btn-danger h-11 min-w-[180px]"><Square size={16} /> Остановить</button>
          ) : (
            <button type="button" onClick={onStart} disabled={starting || !canStart} className="btn-primary h-11 min-w-[180px]">
              {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {primaryLabel}
            </button>
          )}
        </div>
        <button type="button" onClick={onSave} className="btn-ghost h-11 text-sm"><Save size={15} /> Сохранить пресет</button>
      </div>
      {onApplyPreset && presets && presets.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-elevated/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
            <Bookmark size={13} /> Мои пресеты
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <span
                key={p.id}
                className="group inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface pl-3 pr-1.5 py-1.5 text-sm font-medium text-fg transition-colors hover:border-spark-500/40"
              >
                <button
                  type="button"
                  onClick={() => onApplyPreset(p.settings)}
                  disabled={running}
                  title="Применить пресет к настройкам"
                  className="max-w-[180px] truncate text-left disabled:opacity-50"
                >
                  {p.name}
                </button>
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
      {running && task && total > 0 && (
        <div className="mt-4 rounded-2xl border border-line bg-elevated/40 p-4">
          <div className="mb-2 flex justify-between text-sm"><span className="font-semibold text-spark-300">Прогресс</span><span className="font-mono font-bold">{done} / {total}</span></div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-spark-gradient transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
      )}
    </>
  )
}
