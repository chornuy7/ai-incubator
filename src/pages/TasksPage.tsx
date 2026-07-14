import { useEffect, useMemo, useState } from 'react'
import { ListChecks, RefreshCw, Square, RotateCw, Target } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge } from '@/shared/ui'
import { MODULES } from '@/shared/config/modules'
import { fetchAllTasks, stopModuleTask, restartModuleTask, type ModuleTask } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'

const STATUS: Record<string, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  running: { label: 'Выполняется', tone: 'spark' },
  queued: { label: 'В очереди', tone: 'iris' },
  done: { label: 'Готово', tone: 'muted' },
  stopped: { label: 'Остановлена', tone: 'amber' },
  error: { label: 'Ошибка', tone: 'rose' },
}

function moduleTitle(key: string) {
  return MODULES[key]?.title || key
}
function pct(t: ModuleTask) {
  const total = t.progress?.total || 0
  const done = t.progress?.done ?? t.progress?.actionsDone ?? 0
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

export function TasksPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const goalName = useMemo(() => {
    const m = new Map(goals.map((g) => [g.id, g.name]))
    return (id?: string | null) => (id ? m.get(id) || '—' : null)
  }, [goals])

  const load = async () => {
    try {
      const [t, g] = await Promise.all([fetchAllTasks(), fetchGoals().catch(() => [])])
      setTasks(t)
      setGoals(g)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить задачи', desc: err instanceof Error ? err.message : '' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    const id = setInterval(() => { void load() }, 5000) // живой прогресс
    return () => clearInterval(id)
  }, [])

  const doStop = async (t: ModuleTask) => {
    setBusy(t.id)
    try { await stopModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача остановлена' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }
  const doRestart = async (t: ModuleTask) => {
    setBusy(t.id)
    try { await restartModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача перезапущена' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка перезапуска', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length

  return (
    <div>
      <PageHeader
        title="Задачи"
        subtitle="Каждый запуск модуля — задача со статусом и прогрессом. Единый дашборд по всем модулям."
        icon={<ListChecks size={22} />}
        badge={active ? `${active} активных` : undefined}
        actions={<button onClick={() => void load()} className="btn-ghost h-10"><RefreshCw size={16} /> Обновить</button>}
      />

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : tasks.length === 0 ? (
        <EmptyState icon={<ListChecks size={26} />} title="Задач пока нет" desc="Запустите любой модуль — задача появится здесь со статусом и прогрессом." />
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => {
            const st = STATUS[t.status] || { label: t.status, tone: 'muted' as const }
            const p = pct(t)
            const gn = goalName(t.goalId)
            const running = t.status === 'running' || t.status === 'queued'
            return (
              <Card key={`${t.moduleKey}:${t.id}`} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <span className="truncate font-semibold text-white">{moduleTitle(t.moduleKey)}</span>
                    <span className="font-mono text-xs text-white/30">{t.id}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {running && (
                      <button onClick={() => void doStop(t)} disabled={busy === t.id} className="btn-icon h-8 w-8" aria-label="Остановить"><Square size={13} /></button>
                    )}
                    <button onClick={() => void doRestart(t)} disabled={busy === t.id} className="btn-icon h-8 w-8" aria-label="Перезапустить"><RotateCw size={14} /></button>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10">
                  <div className="h-full rounded bg-spark-500 transition-all" style={{ width: `${p}%` }} />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                  <span>{p}% · {t.progress?.done ?? t.progress?.actionsDone ?? 0}/{t.progress?.total ?? 0}</span>
                  {gn && <span className="text-iris-300"><Target size={11} className="mb-0.5 inline" /> {gn}</span>}
                  {t.initiator && <span>кто: {t.initiator}</span>}
                  <span>{new Date(t.createdAt).toLocaleString()}</span>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
