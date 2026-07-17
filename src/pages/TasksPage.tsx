import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ListChecks, RefreshCw, Square, RotateCw, Target, Layers, Activity, Gauge, Pause, Play, Loader2 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select, Segmented, Modal } from '@/shared/ui'
import { MODULES, isCombatModule, combatConfirmText } from '@/shared/config/modules'
import { fetchAllTasks, fetchModuleTask, stopModuleTask, restartModuleTask, pauseModuleTask, resumeModuleTask, type ModuleTask } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { cn } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'

const STATUS: Record<string, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  running: { label: 'Выполняется', tone: 'spark' },
  queued: { label: 'В очереди', tone: 'iris' },
  done: { label: 'Готово', tone: 'muted' },
  stopped: { label: 'Остановлена', tone: 'amber' },
  paused: { label: 'На паузе', tone: 'amber' },
  error: { label: 'Ошибка', tone: 'rose' },
}
// Цвета для колец/диаграммы: завершено=зелёный, активно=голубой, очередь=фиолет, пауза/стоп=янтарь, ошибка=красный.
const STATUS_COLOR: Record<string, string> = {
  done: '#0ec464', running: '#38bdf8', queued: '#7145ff', paused: '#f59e0b', stopped: '#f59e0b', error: '#ef4444',
}
const STATUS_KEYS = ['', 'running', 'queued', 'done', 'stopped', 'error']

function moduleTitle(key: string) { return MODULES[key]?.title || key }
function pct(t: ModuleTask) {
  const total = t.progress?.total || 0
  const done = t.progress?.done ?? t.progress?.actionsDone ?? 0
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}
const isActive = (t: ModuleTask) => t.status === 'running' || t.status === 'queued'

/** Круговое прогресс-кольцо задачи (крутится/пульсирует для активных). */
function Ring({ value, color, size = 46, stroke = 5, pulse }: { value: number; color: string; size?: number; stroke?: number; pulse?: boolean }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const off = c - (Math.max(0, Math.min(100, value)) / 100) * c
  return (
    <div className={`relative shrink-0 ${pulse ? 'animate-pulse-ring rounded-full' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} className="transition-all duration-700" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-[11px] font-bold text-fg">{value}%</div>
    </div>
  )
}

/** Диаграмма-пончик: разбивка задач по статусам, в центре — % завершённых. */
function Donut({ segments, size = 128, stroke = 16 }: { segments: { value: number; color: string; label: string }[]; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const total = segments.reduce((a, s) => a + s.value, 0) || 1
  let acc = 0
  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} />
      {segments.map((s, i) => {
        const dash = (s.value / total) * c
        const el = (
          <circle
            key={i}
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={s.color} strokeWidth={stroke}
            strokeDasharray={`${Math.max(0, dash - 2)} ${c - Math.max(0, dash - 2)}`}
            strokeDashoffset={-acc}
          />
        )
        acc += dash
        return el
      })}
    </svg>
  )
}

export function TasksPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState(0) // 0 — список, 1 — по целям (воронка)
  const [detailTask, setDetailTask] = useState<ModuleTask | null>(null)
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

  // Глубокая ссылка из поп-апа запуска: /panel/tasks?task=<id> — авто-открыть детали задачи (единожды).
  const [autoOpened, setAutoOpened] = useState(false)
  useEffect(() => {
    if (autoOpened || loading) return
    const wanted = new URLSearchParams(window.location.search).get('task')
    if (!wanted) { setAutoOpened(true); return }
    const found = tasks.find((t) => t.id === wanted)
    if (found) { setDetailTask(found); setAutoOpened(true) }
  }, [tasks, loading, autoOpened])

  // Детали должны обновляться из опроса (логи «живые»), а не застывать на моменте клика.
  const liveDetail = useMemo(
    () => (detailTask ? tasks.find((t) => t.id === detailTask.id && t.moduleKey === detailTask.moduleKey) ?? detailTask : null),
    [detailTask, tasks],
  )

  const doStop = async (t: ModuleTask) => {
    setBusy(t.id)
    try { await stopModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача остановлена' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }
  const doRestart = async (t: ModuleTask) => {
    // #4: рестарт боевого модуля = реальные действия в Telegram — подтверждаем.
    if (isCombatModule(t.moduleKey) && !(await confirmDialog({ title: 'Реальные действия в Telegram', message: combatConfirmText(t.moduleKey), confirmLabel: 'Запустить', tone: 'danger' }))) return
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

  // ── Массовый выбор задач + действия над выбранными ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const runBulk = async (label: string, targets: ModuleTask[], fn: (t: ModuleTask) => Promise<unknown>) => {
    if (!targets.length) { pushToast({ type: 'info', title: 'Нет подходящих задач', desc: label }); return }
    setBusy('bulk')
    let ok = 0, fail = 0
    for (const t of targets) { try { await fn(t); ok++ } catch { fail++ } }
    setBusy(null)
    setSelected(new Set())
    await load()
    pushToast({ type: fail ? 'error' : 'success', title: `${label}: ${ok} задач${fail ? ` · ошибок ${fail}` : ''}` })
  }

  const modules = useMemo(() => [...new Set(tasks.map((t) => t.moduleKey))], [tasks])
  const filtered = useMemo(() => tasks.filter((t) =>
    (!fGoal || (fGoal === 'none' ? !t.goalId : t.goalId === fGoal)) &&
    (!fModule || t.moduleKey === fModule) &&
    (!fStatus || t.status === fStatus),
  ), [tasks, fGoal, fModule, fStatus])

  const selectedTasks = useMemo(() => filtered.filter((t) => selected.has(t.id)), [filtered, selected])
  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map((t) => t.id)))
  // Кому какое действие применимо: запуск/возобновление (пауза→resume, стоп/готово/ошибка→restart),
  // пауза (только выполняющиеся), стоп (выполняющиеся/в очереди/на паузе).
  const startTargets = useMemo(() => selectedTasks.filter((t) => ['paused', 'stopped', 'done', 'error'].includes(t.status)), [selectedTasks])
  const pauseTargets = useMemo(() => selectedTasks.filter((t) => t.status === 'running'), [selectedTasks])
  const stopTargets = useMemo(() => selectedTasks.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'paused'), [selectedTasks])

  const bulkStart = async () => {
    // Боевые модули при перезапуске = реальные действия в Telegram — подтверждаем разово.
    if (startTargets.some((t) => t.status !== 'paused' && isCombatModule(t.moduleKey)) &&
        !(await confirmDialog({ title: 'Реальные действия в Telegram', message: 'Перезапуск боевых модулей выполнит реальные действия в Telegram (комментарии / ответы / реакции). Продолжить?', confirmLabel: 'Запустить', tone: 'danger' }))) return
    void runBulk('Запуск/возобновление', startTargets, (t) => (t.status === 'paused' ? resumeModuleTask(t.moduleKey, t.id) : restartModuleTask(t.moduleKey, t.id)))
  }
  const bulkPause = () => void runBulk('Пауза', pauseTargets, (t) => pauseModuleTask(t.moduleKey, t.id))
  const bulkStop = () => void runBulk('Стоп', stopTargets, (t) => stopModuleTask(t.moduleKey, t.id))

  // Воронка: Цели → Задачи → Модули → прогресс (по отфильтрованным).
  const funnel = useMemo(() => {
    const goalsWithTasks = new Set(filtered.filter((t) => t.goalId).map((t) => t.goalId)).size
    const active = filtered.filter(isActive)
    const modulesWorking = new Set(active.map((t) => t.moduleKey)).size
    const withProg = filtered.filter((t) => (t.progress?.total || 0) > 0)
    const avg = withProg.length ? Math.round(withProg.reduce((a, t) => a + pct(t), 0) / withProg.length) : 0
    return { goals: goalsWithTasks, tasks: filtered.length, active: active.length, modulesWorking, avg }
  }, [filtered])

  // Разбивка по статусам для диаграммы завершения.
  const dist = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of filtered) counts[t.status] = (counts[t.status] || 0) + 1
    const order = ['done', 'running', 'queued', 'paused', 'stopped', 'error']
    const segments = order.filter((s) => counts[s]).map((s) => ({ value: counts[s], color: STATUS_COLOR[s], label: STATUS[s]?.label || s }))
    const completion = filtered.length ? Math.round(((counts.done || 0) / filtered.length) * 100) : 0
    return { segments, completion, done: counts.done || 0 }
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

      {/* Блок 1: диаграмма завершения · Блок 2: воронка-метрики */}
      <div className="mb-3 grid gap-2 lg:grid-cols-2">
        <Card className="flex items-center gap-4 p-4">
          <div className="relative grid place-items-center">
            <Donut segments={dist.segments} />
            <div className="absolute inset-0 grid place-items-center text-center">
              <div>
                <div className="text-2xl font-bold text-fg">{dist.completion}%</div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">завершено</div>
              </div>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 text-sm font-bold text-fg">Завершение проекта</div>
            {dist.segments.length === 0 ? (
              <div className="text-xs text-white/40">Нет задач в фильтре</div>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {dist.segments.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5 text-xs">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="truncate text-white/70">{s.label}</span>
                    <span className="ml-auto font-semibold tabular-nums text-fg">{s.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          {stat(<Target size={17} />, 'Целей в работе', funnel.goals, 'text-iris-300')}
          {stat(<ListChecks size={17} />, 'Задач (в фильтре)', funnel.tasks)}
          {stat(<Activity size={17} />, 'Активных / модулей', `${funnel.active} / ${funnel.modulesWorking}`, 'text-amber-300')}
          {stat(<Gauge size={17} />, 'Средний прогресс', `${funnel.avg}%`)}
        </div>
      </div>

      {/* Фильтры + режим */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={setView} size="sm" options={['Список', 'По целям']} />
        <Select value={fGoal} onChange={setFGoal} className="w-48" options={[{ value: '', label: 'Все цели' }, { value: 'none', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
        <Select value={fModule} onChange={setFModule} className="w-48" options={[{ value: '', label: 'Все модули' }, ...modules.map((m) => ({ value: m, label: moduleTitle(m) }))]} />
        <Select value={fStatus} onChange={setFStatus} className="w-44" options={STATUS_KEYS.map((s) => ({ value: s, label: s ? STATUS[s].label : 'Все статусы' }))} />
      </div>

      {/* Массовые действия: выбор + цветные кнопки (старт/пауза/стоп). Серые и неактивные — когда некому применить. */}
      {view === 0 && filtered.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-white/70">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-spark-500" />
            {selected.size > 0 ? `Выбрано: ${selected.size}` : 'Выбрать все'}
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <BulkBtn onClick={bulkStart} disabled={busy !== null || startTargets.length === 0} tone="green" icon={<Play size={13} />} label="Запустить / возобновить" count={startTargets.length} />
            <BulkBtn onClick={bulkPause} disabled={busy !== null || pauseTargets.length === 0} tone="amber" icon={<Pause size={13} />} label="Пауза" count={pauseTargets.length} />
            <BulkBtn onClick={bulkStop} disabled={busy !== null || stopTargets.length === 0} tone="rose" icon={<Square size={13} />} label="Стоп" count={stopTargets.length} />
          </div>
        </div>
      )}

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
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {g.tasks.map((t) => <TaskCard key={`${t.moduleKey}:${t.id}`} t={t} goalName={null} busy={busy} onOpen={setDetailTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} compact />)}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {filtered.map((t) => <TaskCard key={`${t.moduleKey}:${t.id}`} t={t} goalName={goalName(t.goalId)} busy={busy} onOpen={setDetailTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} selected={selected.has(t.id)} onToggleSelect={toggleSel} />)}
        </div>
      )}
      <TaskDetailModal
        t={liveDetail}
        goalName={liveDetail ? goalName(liveDetail.goalId) : null}
        busy={busy}
        onClose={() => setDetailTask(null)}
        onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume}
      />
    </div>
  )
}

/** Цветная кнопка массового действия: зелёная — старт/возобновление, янтарная — пауза, красная — стоп. */
function BulkBtn({ onClick, disabled, tone, icon, label, count }: {
  onClick: () => void; disabled: boolean; tone: 'green' | 'amber' | 'rose'; icon: ReactNode; label: string; count: number
}) {
  const toneCls = tone === 'green'
    ? 'border-spark-500/30 bg-spark-500/15 text-spark-300 hover:bg-spark-500/25'
    : tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
      : 'border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors',
        disabled ? 'border-line bg-elevated text-white/30' : toneCls)}
    >
      {icon} {label}{count > 0 ? ` (${count})` : ''}
    </button>
  )
}

/** Кнопки управления на карточке задачи: старт/возобновление (зелёная), пауза (янтарь), стоп (красная).
 *  Активна только применимая по статусу — остальные приглушены. */
function CardControls({ t, busy, onStop, onRestart, onPause, onResume }: {
  t: ModuleTask; busy: string | null
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void
}) {
  const disabled = busy === t.id
  const canStart = ['paused', 'stopped', 'done', 'error'].includes(t.status)
  const canPause = t.status === 'running'
  const canStop = t.status === 'running' || t.status === 'queued' || t.status === 'paused'
  const startTitle = t.status === 'paused' ? 'Возобновить' : 'Запустить'
  const cls = (active: boolean, tone: string) => cn('btn-icon h-8 w-8', active && !disabled ? tone : 'text-white/20')
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button onClick={() => (t.status === 'paused' ? onResume(t) : onRestart(t))} disabled={disabled || !canStart} className={cls(canStart, 'text-spark-400 hover:bg-spark-500/12')} aria-label={startTitle} title={startTitle}><Play size={13} /></button>
      <button onClick={() => onPause(t)} disabled={disabled || !canPause} className={cls(canPause, 'text-amber-300 hover:bg-amber-500/12')} aria-label="Пауза" title="Пауза"><Pause size={13} /></button>
      <button onClick={() => onStop(t)} disabled={disabled || !canStop} className={cls(canStop, 'text-rose-300 hover:bg-rose-500/12')} aria-label="Стоп" title="Стоп"><Square size={13} /></button>
    </div>
  )
}

function TaskCard({ t, goalName, busy, onOpen, onStop, onRestart, onPause, onResume, compact, selected, onToggleSelect }: {
  t: ModuleTask; goalName: string | null; busy: string | null
  onOpen: (t: ModuleTask) => void
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; compact?: boolean
  selected?: boolean; onToggleSelect?: (id: string) => void
}) {
  const st = STATUS[t.status] || { label: t.status, tone: 'muted' as const }
  const p = pct(t)
  const running = isActive(t)
  const ringColor = STATUS_COLOR[t.status] || '#94a3b8'
  return (
    <Card className={compact ? 'flex items-center gap-3 bg-elevated/40 p-2.5' : 'flex items-center gap-3 p-3'}>
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(t.id)}
          className="h-4 w-4 shrink-0 accent-spark-500"
          aria-label="Выбрать задачу"
        />
      )}
      <button type="button" onClick={() => onOpen(t)} className="flex min-w-0 flex-1 items-center gap-3 text-left" title="Открыть детали задачи">
      <Ring value={p} color={ringColor} size={compact ? 40 : 48} pulse={running} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="truncate font-semibold text-white">{moduleTitle(t.moduleKey)}</span>
          <span className="font-mono text-[11px] text-white/30">{t.id}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/40">
          <span className="tabular-nums">{t.progress?.done ?? t.progress?.actionsDone ?? 0}/{t.progress?.total ?? 0}</span>
          {goalName && <span className="text-iris-300"><Target size={11} className="mb-0.5 inline" /> {goalName}</span>}
          {t.initiator && <span>кто: {t.initiator}</span>}
          <span>{new Date(t.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
      </button>
      <CardControls t={t} busy={busy} onStop={onStop} onRestart={onRestart} onPause={onPause} onResume={onResume} />
    </Card>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-fg">{value}</div>
    </div>
  )
}

const LOG_COLOR: Record<string, string> = { error: 'text-rose-300', warning: 'text-amber-300', success: 'text-spark-300', info: 'text-white/70' }

/** Поп-ап с полной информацией по задаче: статус, прогресс, настройки, логи + управление. */
function TaskDetailModal({ t, goalName, busy, onClose, onStop, onRestart, onPause, onResume }: {
  t: ModuleTask | null; goalName: string | null; busy: string | null; onClose: () => void
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void
}) {
  // Список задач приходит БЕЗ логов (тяжело гонять) — полную задачу с логами тянем отдельно и опрашиваем.
  const [full, setFull] = useState<ModuleTask | null>(null)
  useEffect(() => {
    if (!t) { setFull(null); return }
    let cancelled = false
    const pull = async () => {
      try { const f = await fetchModuleTask(t.moduleKey, t.id); if (!cancelled) setFull(f) } catch { /* ignore */ }
    }
    void pull()
    const iv = setInterval(pull, 3000) // живые логи, пока открыто
    return () => { cancelled = true; clearInterval(iv) }
  }, [t?.id, t?.moduleKey])

  if (!t) return null
  const detailed = full && full.id === t.id ? full : t // с логами, если уже подгрузилось
  const st = STATUS[t.status] || { label: t.status, tone: 'muted' as const }
  const p = pct(t)
  const s = detailed.settings || t.settings || {}
  const logs = (detailed.logs || []).slice(0, 80)
  const results = detailed.results || detailed.commentHistory || []
  return (
    <Modal open={!!t} onClose={onClose} size="lg" title={`Задача · ${moduleTitle(t.moduleKey)}`} subtitle={t.id}
      footer={<button onClick={onClose} className="btn-primary h-10">Закрыть</button>}>
      <div className="space-y-4">
        <div className="flex items-center gap-4 rounded-2xl border border-line bg-elevated/40 p-4">
          <Ring value={p} color={STATUS_COLOR[t.status] || '#94a3b8'} size={66} stroke={6} pulse={isActive(t)} />
          <div className="min-w-0 flex-1">
            <Badge tone={st.tone}>{st.label}</Badge>
            <div className="mt-1 text-sm text-white/60">{t.progress?.done ?? t.progress?.actionsDone ?? 0} / {t.progress?.total ?? 0} действий</div>
          </div>
          <div className="flex shrink-0 gap-1">
            {isActive(t) && <button onClick={() => onPause(t)} disabled={busy === t.id} className="btn-icon h-9 w-9" title="Пауза"><Pause size={15} /></button>}
            {t.status === 'paused' && <button onClick={() => onResume(t)} disabled={busy === t.id} className="btn-icon h-9 w-9 text-spark-400" title="Продолжить"><Play size={15} /></button>}
            {isActive(t) && <button onClick={() => onStop(t)} disabled={busy === t.id} className="btn-icon h-9 w-9 text-rose-300" title="Стоп"><Square size={15} /></button>}
            <button onClick={() => onRestart(t)} disabled={busy === t.id} className="btn-icon h-9 w-9" title="Перезапуск"><RotateCw size={16} /></button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Info label="Модуль" value={moduleTitle(t.moduleKey)} />
          <Info label="Цель" value={goalName || 'без цели'} />
          <Info label="Инициатор" value={t.initiator || '—'} />
          <Info label="Аккаунтов" value={String((s.accountIds || []).length)} />
          <Info label="Каналов / целей" value={String((s.channels || s.targets || []).length)} />
          <Info label="На аккаунт" value={`${s.minPerAccount ?? 0}–${s.maxPerAccount ?? 0}`} />
          <Info label="Создана" value={new Date(t.createdAt).toLocaleString('ru-RU')} />
          <Info label="Обновлена" value={new Date(t.updatedAt).toLocaleString('ru-RU')} />
          <Info label="Результатов" value={String(results.length)} />
        </div>
        <div className="rounded-2xl border border-line bg-elevated/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg">Логи ({(detailed.logs || []).length}){!full && <Loader2 size={13} className="animate-spin text-white/40" />}</div>
          {logs.length === 0 ? (
            <div className="py-3 text-center text-xs text-white/40">Логов пока нет</div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="shrink-0 text-white/30">{new Date(l.ts).toLocaleTimeString('ru-RU')}</span>
                  <span className={LOG_COLOR[l.level] || 'text-white/70'}>{l.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
