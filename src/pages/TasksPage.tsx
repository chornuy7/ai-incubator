import { useEffect, useMemo, useState } from 'react'
import { ListChecks, RefreshCw, Square, RotateCw, Target, Layers, Activity, Gauge, Pause, Play } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select, Segmented } from '@/shared/ui'
import { MODULES } from '@/shared/config/modules'
import { fetchAllTasks, stopModuleTask, restartModuleTask, pauseModuleTask, resumeModuleTask, type ModuleTask } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'

const STATUS: Record<string, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  running: { label: 'Выполняется', tone: 'spark' },
  queued: { label: 'В очереди', tone: 'iris' },
  done: { label: 'Готово', tone: 'muted' },
  stopped: { label: 'Остановлена', tone: 'amber' },
  paused: { label: 'На паузе', tone: 'amber' },
  error: { label: 'Ошибка', tone: 'rose' },
}
const STATUS_KEYS = ['', 'running', 'queued', 'done', 'stopped', 'error']

function moduleTitle(key: string) { return MODULES[key]?.title || key }
function pct(t: ModuleTask) {
  const total = t.progress?.total || 0
  const done = t.progress?.done ?? t.progress?.actionsDone ?? 0
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}
const isActive = (t: ModuleTask) => t.status === 'running' || t.status === 'queued'

export function TasksPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState(0) // 0 — список, 1 — по целям (воронка)
  const [fGoal, setFGoal] = useState('')
  const [fModule, setFModule] = useState('')
  const [fStatus, setFStatus] = useState('')

  const goalName = useMemo(() => {
    const m = new Map(goals.map((g) => [g.id, g.name]))
    return (id?: string | null) => (id ? m.get(id) || '—' : null)
  }, [goals])

  const load = async () => {
    try {
      const [t, g] = await Promise.all([fetchAllTasks(), fetchGoals().catch(() => [])])
      setTasks(t); setGoals(g)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить задачи', desc: err instanceof Error ? err.message : '' })
    } finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    const id = setInterval(() => { void load() }, 5000)
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
  const doPause = async (t: ModuleTask) => {
    setBusy(t.id)
    try { await pauseModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача на паузе' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }
  const doResume = async (t: ModuleTask) => {
    setBusy(t.id)
    try { await resumeModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача продолжена' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка продолжения', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }

  const modules = useMemo(() => [...new Set(tasks.map((t) => t.moduleKey))], [tasks])
  const filtered = useMemo(() => tasks.filter((t) =>
    (!fGoal || (fGoal === 'none' ? !t.goalId : t.goalId === fGoal)) &&
    (!fModule || t.moduleKey === fModule) &&
    (!fStatus || t.status === fStatus),
  ), [tasks, fGoal, fModule, fStatus])

  // Воронка: Цели → Задачи → Модули → прогресс (по отфильтрованным).
  const funnel = useMemo(() => {
    const goalsWithTasks = new Set(filtered.filter((t) => t.goalId).map((t) => t.goalId)).size
    const active = filtered.filter(isActive)
    const modulesWorking = new Set(active.map((t) => t.moduleKey)).size
    const withProg = filtered.filter((t) => (t.progress?.total || 0) > 0)
    const avg = withProg.length ? Math.round(withProg.reduce((a, t) => a + pct(t), 0) / withProg.length) : 0
    return { goals: goalsWithTasks, tasks: filtered.length, active: active.length, modulesWorking, avg }
  }, [filtered])

  // Группировка по целям (преследование цели).
  const byGoal = useMemo(() => {
    const groups = new Map<string, ModuleTask[]>()
    for (const t of filtered) {
      const k = t.goalId || 'none'
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(t)
    }
    return [...groups.entries()].map(([gid, ts]) => {
      const total = ts.reduce((a, t) => a + (t.progress?.total || 0), 0)
      const done = ts.reduce((a, t) => a + (t.progress?.done ?? t.progress?.actionsDone ?? 0), 0)
      return {
        gid,
        name: gid === 'none' ? 'Без цели' : goalName(gid) || '—',
        tasks: ts,
        active: ts.filter(isActive).length,
        modules: [...new Set(ts.map((t) => t.moduleKey))],
        prog: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
      }
    }).sort((a, b) => b.active - a.active || b.tasks.length - a.tasks.length)
  }, [filtered, goalName])

  const stat = (icon: React.ReactNode, label: string, value: React.ReactNode, tone = 'text-spark-300') => (
    <Card className="flex items-center gap-3 p-3">
      <span className={`grid h-9 w-9 place-items-center rounded-xl bg-elevated ${tone}`}>{icon}</span>
      <div><div className="text-lg font-bold text-fg">{value}</div><div className="text-[11px] text-white/40">{label}</div></div>
    </Card>
  )

  return (
    <div>
      <PageHeader
        title="Дашборд задач"
        subtitle="Цели → Задачи → Модули: единый экран прогресса. Фильтры-воронка + преследование цели. §8.8"
        icon={<ListChecks size={22} />}
        badge={funnel.active ? `${funnel.active} активных` : undefined}
        actions={<button onClick={() => void load()} className="btn-ghost h-10"><RefreshCw size={16} /> Обновить</button>}
      />

      {/* Воронка */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat(<Target size={17} />, 'Целей в работе', funnel.goals, 'text-iris-300')}
        {stat(<ListChecks size={17} />, 'Задач (в фильтре)', funnel.tasks)}
        {stat(<Activity size={17} />, 'Активных / модулей', `${funnel.active} / ${funnel.modulesWorking}`, 'text-amber-300')}
        {stat(<Gauge size={17} />, 'Средний прогресс', `${funnel.avg}%`)}
      </div>

      {/* Фильтры + режим */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={setView} size="sm" options={['Список', 'По целям']} />
        <Select value={fGoal} onChange={setFGoal} className="w-48" options={[{ value: '', label: 'Все цели' }, { value: 'none', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
        <Select value={fModule} onChange={setFModule} className="w-48" options={[{ value: '', label: 'Все модули' }, ...modules.map((m) => ({ value: m, label: moduleTitle(m) }))]} />
        <Select value={fStatus} onChange={setFStatus} className="w-44" options={STATUS_KEYS.map((s) => ({ value: s, label: s ? STATUS[s].label : 'Все статусы' }))} />
      </div>

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ListChecks size={26} />} title="Задач нет" desc="Запустите модуль или измените фильтры — задачи появятся здесь." />
      ) : view === 1 ? (
        // По целям (воронка преследования цели)
        <div className="flex flex-col gap-3">
          {byGoal.map((g) => (
            <Card key={g.gid} className="p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone={g.gid === 'none' ? 'muted' : 'iris'}>{g.gid === 'none' ? <Layers size={12} className="mb-0.5 inline" /> : <Target size={12} className="mb-0.5 inline" />} {g.name}</Badge>
                <span className="text-xs text-white/50">{g.tasks.length} задач · {g.active} активных</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {g.modules.map((m) => <span key={m} className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-white/50">{moduleTitle(m)}</span>)}
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full rounded bg-iris-500 transition-all" style={{ width: `${g.prog}%` }} /></div>
              <div className="mt-1 text-[11px] text-white/40">Прогресс к цели: {g.prog}%</div>
              <div className="mt-2 flex flex-col gap-1.5">
                {g.tasks.map((t) => <TaskRow key={`${t.moduleKey}:${t.id}`} t={t} goalName={null} busy={busy} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} compact />)}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((t) => <TaskRow key={`${t.moduleKey}:${t.id}`} t={t} goalName={goalName(t.goalId)} busy={busy} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} />)}
        </div>
      )}
    </div>
  )
}

function TaskRow({ t, goalName, busy, onStop, onRestart, onPause, onResume, compact }: {
  t: ModuleTask; goalName: string | null; busy: string | null
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; compact?: boolean
}) {
  const st = STATUS[t.status] || { label: t.status, tone: 'muted' as const }
  const p = pct(t)
  const running = isActive(t)
  return (
    <Card className={compact ? 'bg-elevated/40 p-2.5' : 'p-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="truncate font-semibold text-white">{moduleTitle(t.moduleKey)}</span>
          <span className="font-mono text-xs text-white/30">{t.id}</span>
        </div>
        <div className="flex items-center gap-1">
          {running && <button onClick={() => onPause(t)} disabled={busy === t.id} className="btn-icon h-8 w-8" aria-label="Пауза" title="Пауза"><Pause size={13} /></button>}
          {t.status === 'paused' && <button onClick={() => onResume(t)} disabled={busy === t.id} className="btn-icon h-8 w-8 text-spark-400" aria-label="Продолжить" title="Продолжить"><Play size={13} /></button>}
          {running && <button onClick={() => onStop(t)} disabled={busy === t.id} className="btn-icon h-8 w-8" aria-label="Остановить"><Square size={13} /></button>}
          <button onClick={() => onRestart(t)} disabled={busy === t.id} className="btn-icon h-8 w-8" aria-label="Перезапустить"><RotateCw size={14} /></button>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full rounded bg-spark-500 transition-all" style={{ width: `${p}%` }} /></div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
        <span>{p}% · {t.progress?.done ?? t.progress?.actionsDone ?? 0}/{t.progress?.total ?? 0}</span>
        {goalName && <span className="text-iris-300"><Target size={11} className="mb-0.5 inline" /> {goalName}</span>}
        {t.initiator && <span>кто: {t.initiator}</span>}
        <span>{new Date(t.createdAt).toLocaleString()}</span>
      </div>
    </Card>
  )
}
