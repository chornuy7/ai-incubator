import { createPortal } from 'react-dom'
import { X, Play, Pause, Square, Trash2, ListChecks, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { useUi } from '@/shared/lib/uiStore'
import { EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import type { TaskStatus } from '@/shared/types'

const STATUS_META: Record<TaskStatus, { label: string; icon: React.ReactNode; color: string }> = {
  running: { label: 'Выполняется', icon: <Loader2 size={14} className="animate-spin" />, color: 'text-spark-300' },
  paused: { label: 'Пауза', icon: <Pause size={14} />, color: 'text-amber-300' },
  done: { label: 'Готово', icon: <CheckCircle2 size={14} />, color: 'text-spark-300' },
  error: { label: 'Ошибка', icon: <AlertTriangle size={14} />, color: 'text-rose-300' },
  queued: { label: 'В очереди', icon: <Loader2 size={14} />, color: 'text-muted' },
}

export function TasksDrawer() {
  const open = useUi((s) => s.tasksOpen)
  const setOpen = useUi((s) => s.setTasksOpen)
  const tasks = useApp((s) => s.data.tasks)
  const updateTask = useApp((s) => s.updateTask)
  const removeTask = useApp((s) => s.removeTask)
  const pushToast = useApp((s) => s.pushToast)

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[95]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-pop animate-fade-in">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ListChecks size={20} className="text-spark-400" />
            <div>
              <h3 className="font-display text-lg font-bold text-fg">Задачи</h3>
              <p className="text-xs text-muted">{tasks.length} активных процессов</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="btn-icon"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tasks.length === 0 ? (
            <EmptyState icon={<ListChecks size={26} />} title="Нет активных задач" desc="Запустите любой модуль — задача появится здесь." />
          ) : (
            <div className="space-y-3">
              {tasks.map((t) => {
                const m = STATUS_META[t.status]
                return (
                  <div key={t.id} className="rounded-2xl border border-line bg-elevated p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-fg">{t.title}</div>
                        <div className={cn('mt-0.5 flex items-center gap-1.5 text-xs font-semibold', m.color)}>
                          {m.icon} {m.label} · {t.accountsCount} акк. · {t.logCount} логов
                        </div>
                      </div>
                    </div>
                    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className={cn('h-full rounded-full transition-all', t.status === 'error' ? 'bg-rose-500' : 'bg-spark-gradient')}
                        style={{ width: `${t.progress}%` }}
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-1.5">
                      {t.status === 'running' ? (
                        <button onClick={() => updateTask(t.id, { status: 'paused' })} className="btn-ghost h-8 flex-1 text-xs">
                          <Pause size={13} /> Пауза
                        </button>
                      ) : t.status === 'paused' ? (
                        <button onClick={() => updateTask(t.id, { status: 'running' })} className="btn-soft h-8 flex-1 text-xs">
                          <Play size={13} /> Возобновить
                        </button>
                      ) : null}
                      {(t.status === 'running' || t.status === 'paused') && (
                        <button
                          onClick={() => { updateTask(t.id, { status: 'done', progress: 100 }); pushToast({ type: 'success', title: 'Задача остановлена', desc: t.title }) }}
                          className="btn-ghost h-8 text-xs"
                        >
                          <Square size={13} /> Стоп
                        </button>
                      )}
                      <button onClick={() => removeTask(t.id)} className="btn-icon h-8 w-8 text-rose-300"><Trash2 size={14} /></button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
