import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ListChecks, RefreshCw, Square, RotateCw, Target, Activity, Gauge, Pause, Play, Loader2, ArrowLeft, Pencil, Download } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select, Segmented } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { MODULES, isCombatModule, combatConfirmText } from '@/shared/config/modules'
import { fetchAllTasks, fetchModuleTask, stopModuleTask, restartModuleTask, pauseModuleTask, resumeModuleTask, updateModuleTaskSettings, type ModuleTask, type ModuleTaskSettings } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'
import { fetchAccounts } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { cn, coins as fmtCoins } from '@/shared/lib/utils'
import { confirmDialog, promptDialog } from '@/shared/lib/dialog'
import { TaskAudiencePanel } from '@/features/mailing/TaskAudiencePanel'
import { launchWithSkip } from '@/features/modules/shared/launchWithSkip'
import { massStopConfirmSteps, canStopWarming, containsWarming } from '@/shared/lib/massAction'
import { useSession } from '@/features/auth/session'
import { canControlModule } from '@/shared/lib/access'
import { downloadXls } from '@/shared/lib/exportXls'

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

// mailing/autoposting — отдельные страницы, их нет в MODULES; задаём читаемые названия.
const EXTRA_MODULE_TITLES: Record<string, string> = { mailing: 'Мейлинг', autoposting: 'Автопостинг' }
function moduleTitle(key: string) { return MODULES[key]?.title || EXTRA_MODULE_TITLES[key] || key }
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
  const me = useSession((s) => s.user) // §12: прогрев останавливает только супер-админ
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState(0) // 0 — список, 1 — по целям (воронка)
  const navigate = useNavigate()
  // §8: задача открывается отдельной вьюшкой /panel/tasks/:id, а не модалкой.
  const openTask = (t: ModuleTask) => navigate(`/panel/tasks/${t.id}?m=${t.moduleKey}`)
  const [fGoal, setFGoal] = useState('')
  const [fModule, setFModule] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [goalSel, setGoalSel] = useState<Set<string>>(new Set()) // выбор целей в виде «По целям» (пусто = все)

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
    // §8: старая deep-ссылка ?task= теперь ведёт на отдельную вьюшку задачи.
    if (found) { setAutoOpened(true); navigate(`/panel/tasks/${found.id}?m=${found.moduleKey}`, { replace: true }) }
  }, [tasks, loading, autoOpened, navigate])

  // Глубокая ссылка из модуля: /panel/tasks?module=<key> — предфильтр по этому модулю (§7).
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('module')
    if (m) setFModule(m)
  }, [])

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
    // Часть аккаунтов в карантине/спамблоке — не валим запуск, а предлагаем без них.
    // Рестарт создаёт НОВУЮ задачу, старая остаётся «Остановлена» — говорим об этом
    // явно, иначе выглядит как «ничего не произошло» (тест 6.2).
    try {
      const fresh = await launchWithSkip((skip) => restartModuleTask(t.moduleKey, t.id, skip))
      if (fresh) { pushToast({ type: 'success', title: 'Создана новая задача', desc: `${fresh.id} — прежняя ${t.id} осталась остановленной` }); await load() }
    }
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

  // Нет доступа к модулю — нет и кнопок. Показывать управление, которое ответит
  // отказом, значит предлагать действие и тут же его отбирать.
  const canControl = (t: ModuleTask) => !me || canControlModule(me.permissions, me.isAdmin, t.moduleKey)

  const selectedTasks = useMemo(() => filtered.filter((t) => selected.has(t.id) && canControl(t)), [filtered, selected, me])
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
    // Массовый запуск: недоступные аккаунты исключаем сразу. Спрашивать по каждой
    // задаче отдельно — двадцать одинаковых вопросов подряд, никто так не работает.
    void runBulk('Запуск/возобновление', startTargets, (t) => (t.status === 'paused' ? resumeModuleTask(t.moduleKey, t.id) : restartModuleTask(t.moduleKey, t.id, true)))
  }
  const bulkPause = () => void runBulk('Пауза', pauseTargets, (t) => pauseModuleTask(t.moduleKey, t.id))
  /**
   * §12: массовый стоп защищён. Прогрев — только супер-админ (недели работы можно
   * обнулить одним кликом), а большой объём требует усиленного подтверждения.
   */
  const bulkStop = async () => {
    if (containsWarming(stopTargets) && !canStopWarming(!!me?.isAdmin)) {
      return pushToast({
        type: 'error',
        title: 'Прогрев остановить нельзя',
        desc: 'Среди выбранных есть задачи прогрева — их останавливает только супер-админ.',
      })
    }
    const steps = massStopConfirmSteps(stopTargets.length)
    if (steps === 0) return
    const warmN = stopTargets.filter((t) => t.moduleKey === 'warming').length
    const warnTail = warmN ? ` Из них прогрева: ${warmN} — прогресс будет потерян.` : ''
    if (!(await confirmDialog({
      title: `Остановить задач: ${stopTargets.length}?`,
      message: `Задачи будут остановлены.${warnTail}`,
      confirmLabel: 'Остановить',
      tone: 'danger',
    }))) return
    if (steps === 2) {
      // Второй барьер при большом объёме: осознанное подтверждение вводом числа.
      const typed = await promptDialog({
        title: 'Подтвердите массовую остановку',
        message: `Это ${stopTargets.length} задач — действие необратимо. Введите число ${stopTargets.length}, если прочитали и уверены.`,
        placeholder: String(stopTargets.length),
      })
      if (String(typed || '').trim() !== String(stopTargets.length)) {
        return pushToast({ type: 'info', title: 'Отменено', desc: 'Подтверждение не совпало — ничего не остановлено.' })
      }
    }
    void runBulk('Стоп', stopTargets, (t) => stopModuleTask(t.moduleKey, t.id))
  }

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

  // Список целей, у которых есть задачи (для фильтра в виде «По целям»).
  const goalsWithTasks = useMemo(() => {
    const ids = new Set(filtered.filter((t) => t.goalId).map((t) => t.goalId as string))
    return goals.filter((g) => ids.has(g.id))
  }, [filtered, goals])

  // Группировка по целям (преследование цели). Задачи без цели сюда НЕ попадают —
  // «преследовать» нечего; их место — во вкладке «Список». Фильтр goalSel сужает набор.
  const byGoal = useMemo(() => {
    const groups = new Map<string, ModuleTask[]>()
    for (const t of filtered) {
      if (!t.goalId) continue // без цели — не в разрезе целей
      if (goalSel.size && !goalSel.has(t.goalId)) continue // выбраны конкретные цели
      if (!groups.has(t.goalId)) groups.set(t.goalId, [])
      groups.get(t.goalId)!.push(t)
    }
    return [...groups.entries()].map(([gid, ts]) => {
      const total = ts.reduce((a, t) => a + (t.progress?.total || 0), 0)
      const done = ts.reduce((a, t) => a + (t.progress?.done ?? t.progress?.actionsDone ?? 0), 0)
      return {
        gid,
        name: goalName(gid) || '—',
        tasks: ts,
        active: ts.filter(isActive).length,
        modules: [...new Set(ts.map((t) => t.moduleKey))],
        prog: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
      }
    }).sort((a, b) => b.active - a.active || b.tasks.length - a.tasks.length)
  }, [filtered, goalName, goalSel])

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
        actions={<div className="flex items-center gap-2"><HelpButton topic="tasks" className="h-10 w-10" /><button onClick={() => void load()} className="btn-ghost h-10"><RefreshCw size={16} /> Обновить</button></div>}
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
        <Select value={fModule} onChange={setFModule} className="w-48" options={[{ value: '', label: 'Все модули' }, ...modules.map((m) => ({ value: m, label: moduleTitle(m) })), ...(fModule && !modules.includes(fModule) ? [{ value: fModule, label: moduleTitle(fModule) }] : [])]} />
        <Select value={fStatus} onChange={setFStatus} className="w-44" options={STATUS_KEYS.map((s) => ({ value: s, label: s ? STATUS[s].label : 'Все статусы' }))} />
      </div>

      {/* Фильтр по целям — только в разрезе «По целям»: выбрать, какие цели смотреть (пусто = все). */}
      {view === 1 && goalsWithTasks.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-2.5">
          <span className="text-xs font-semibold text-white/60"><Target size={12} className="mb-0.5 inline" /> Цели:</span>
          <button type="button" onClick={() => setGoalSel(new Set())} className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors', goalSel.size === 0 ? 'border-iris-500/50 bg-iris-500/15 text-iris-200' : 'border-line text-white/50 hover:text-white/80')}>Все</button>
          {goalsWithTasks.map((g) => {
            const on = goalSel.has(g.id)
            return (
              <button key={g.id} type="button" onClick={() => setGoalSel((prev) => { const n = new Set(prev); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n })} className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors', on ? 'border-iris-500/50 bg-iris-500/15 text-iris-200' : 'border-line text-white/50 hover:text-white/80')}>
                {g.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Массовые действия: выбор + цветные кнопки (старт/пауза/стоп). Серые и неактивные — когда некому применить. */}
      {view === 0 && filtered.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-white/70">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-spark-500" />
            {selected.size > 0 ? `Выбрано: ${selected.size}` : 'Выбрать все'}
          </label>
          {/* Если ни одной подконтрольной задачи в списке нет — массовых кнопок не
              показываем: они предлагали бы действия, которые все до одного отказали бы. */}
          {filtered.some(canControl) && <div className="ml-auto flex flex-wrap items-center gap-2">
            <BulkBtn onClick={bulkStart} disabled={busy !== null || startTargets.length === 0} tone="green" icon={<Play size={13} />} label="Запустить / возобновить" count={startTargets.length} />
            <BulkBtn onClick={bulkPause} disabled={busy !== null || pauseTargets.length === 0} tone="amber" icon={<Pause size={13} />} label="Пауза" count={pauseTargets.length} />
            <BulkBtn onClick={() => void bulkStop()} disabled={busy !== null || stopTargets.length === 0} tone="rose" icon={<Square size={13} />} label="Стоп" count={stopTargets.length} />
          </div>}
        </div>
      )}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ListChecks size={26} />} title="Задач нет" desc="Запустите модуль или измените фильтры — задачи появятся здесь." />
      ) : view === 1 ? (
        // По целям (воронка преследования цели) — задачи без цели сюда не входят.
        byGoal.length === 0 ? (
          <EmptyState icon={<Target size={26} />} title="Нет задач с целью" desc="Задачи без цели показаны во вкладке «Список». Привяжите цель при запуске модуля, чтобы вести их к целевому действию." />
        ) : (
        <div className="flex flex-col gap-3">
          {byGoal.map((g) => (
            <Card key={g.gid} className="p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone="iris"><Target size={12} className="mb-0.5 inline" /> {g.name}</Badge>
                <span className="text-xs text-white/50">{g.tasks.length} задач · {g.active} активных</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {g.modules.map((m) => <span key={m} className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-white/50">{moduleTitle(m)}</span>)}
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full rounded bg-iris-500 transition-all" style={{ width: `${g.prog}%` }} /></div>
              <div className="mt-1 text-[11px] text-white/40">Прогресс к цели: {g.prog}%</div>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {g.tasks.map((t) => <TaskCard key={`${t.moduleKey}:${t.id}`} t={t} goalName={null} busy={busy} onOpen={openTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} canControl={canControl(t)} compact />)}
              </div>
            </Card>
          ))}
        </div>
        )
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {filtered.map((t) => <TaskCard key={`${t.moduleKey}:${t.id}`} t={t} goalName={goalName(t.goalId)} busy={busy} onOpen={openTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} canControl={canControl(t)} selected={selected.has(t.id)} onToggleSelect={toggleSel} />)}
        </div>
      )}
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
function CardControls({ t, busy, onStop, onRestart, onPause, onResume, canControl = true }: {
  t: ModuleTask; busy: string | null
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; canControl?: boolean
}) {
  // Нет доступа к модулю — управления нет вовсе. Неактивная кнопка тут читалась бы
  // как «сейчас нельзя», хотя нельзя вообще.
  if (!canControl) return null
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

function TaskCard({ t, goalName, busy, onOpen, onStop, onRestart, onPause, onResume, canControl = true, compact, selected, onToggleSelect }: {
  t: ModuleTask; goalName: string | null; busy: string | null
  onOpen: (t: ModuleTask) => void
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; canControl?: boolean; compact?: boolean
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
          {/* Во сколько обошёлся запуск. Из общего баланса не понять, куда ушли монеты,
              а «сколько стоила вот эта задача» — первый вопрос при разборе счёта. */}
          {!!t.spentCoins && <span className="tabular-nums text-amber-300/80" title="Потрачено монет на эту задачу">⚡ {fmtCoins(t.spentCoins)}</span>}
          <span>{new Date(t.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
      </button>
      <CardControls t={t} busy={busy} onStop={onStop} onRestart={onRestart} onPause={onPause} onResume={onResume} canControl={canControl} />
    </Card>
  )
}

function Info({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-fg" title={hint}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-[10px] text-muted">{hint}</div>}
    </div>
  )
}

/** Список чипов (аккаунты / каналы / ссылки) в деталях задачи. */
function ChipList({ title, count, items, empty, tone, mono }: {
  title: string; count: number; items: string[]; empty: string; tone: 'iris' | 'spark'; mono?: boolean
}) {
  const toneCls = tone === 'iris' ? 'border-iris-500/25 bg-iris-500/10 text-iris-200' : 'border-spark-500/25 bg-spark-500/10 text-spark-200'
  const MAX = 80
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 text-sm font-bold text-fg">{title} <span className="text-white/40">({count})</span></div>
      {items.length === 0 ? (
        empty ? <div className="py-1 text-xs text-white/40">{empty}</div> : null
      ) : (
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {items.slice(0, MAX).map((it, i) => (
            <span key={i} className={cn('max-w-full truncate rounded-lg border px-2 py-0.5 text-xs', mono && 'font-mono', toneCls)}>{it}</span>
          ))}
          {items.length > MAX && <span className="px-1 py-0.5 text-xs text-white/40">+{items.length - MAX}</span>}
        </div>
      )}
    </div>
  )
}

const LOG_COLOR: Record<string, string> = { error: 'text-rose-300', warning: 'text-amber-300', success: 'text-spark-300', info: 'text-white/70' }

/**
 * §8: отдельная вьюшка задачи (/panel/tasks/:id?m=<moduleKey>) вместо модалки.
 * Кнопка «Назад», заголовок = модуль + номер, полные логи + результаты + управление.
 */
export function TaskDetailPage() {
  const { id = '' } = useParams()
  const me = useSession((s) => s.user)
  const [sp] = useSearchParams()
  const moduleKey = sp.get('m') || ''
  const navigate = useNavigate()
  const pushToast = useApp((s) => s.pushToast)

  const [task, setTask] = useState<ModuleTask | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [goals, setGoals] = useState<Goal[]>([])
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetchGoals().then(setGoals).catch(() => {})
    void fetchAccounts().then(setAccounts).catch(() => {})
    void fetchCampaigns().then(({ campaigns }) => setCampaignsList(campaigns)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id || !moduleKey) { setNotFound(true); return }
    let cancelled = false
    const pull = async () => {
      try { const f = await fetchModuleTask(moduleKey, id); if (!cancelled) { setTask(f); if (!f) setNotFound(true) } }
      catch { if (!cancelled) setNotFound(true) }
    }
    void pull()
    const iv = setInterval(pull, 3000) // живые логи, пока открыто
    return () => { cancelled = true; clearInterval(iv) }
  }, [id, moduleKey])

  const goalName = (gid?: string | null) => { const g = goals.find((x) => x.id === gid); return g?.name || (gid ? '—' : null) }
  const accountName = (aid: string) => { const a = accounts.find((x) => x.id === aid); return a ? (a.name || a.username || a.phone || a.id) : aid }

  const reload = async () => { try { setTask(await fetchModuleTask(moduleKey, id)) } catch { /* ignore */ } }
  const run = async (fn: () => Promise<unknown>, okTitle: string) => {
    setBusy(true)
    try { await fn(); pushToast({ type: 'success', title: okTitle }); await reload() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(false) }
  }
  const doStop = () => void run(() => stopModuleTask(moduleKey, id), 'Задача остановлена')
  const doPause = () => void run(() => pauseModuleTask(moduleKey, id), 'Задача на паузе')
  const doResume = () => void run(() => resumeModuleTask(moduleKey, id), 'Задача продолжена')
  const doRestart = async () => {
    // #4: рестарт боевого модуля = реальные действия в Telegram — подтверждаем.
    if (isCombatModule(moduleKey) && !(await confirmDialog({ title: 'Реальные действия в Telegram', message: combatConfirmText(moduleKey), confirmLabel: 'Запустить', tone: 'danger' }))) return
    // Отказ в диалоге исключения — не ошибка. Рестарт заводит НОВУЮ задачу, старая
    // остаётся «Остановлена» — переходим на новую, иначе кажется, что кнопка не сработала (тест 6.2).
    setBusy(true)
    try {
      const fresh = await launchWithSkip((skip) => restartModuleTask(moduleKey, id, skip))
      if (fresh) { pushToast({ type: 'success', title: 'Создана новая задача', desc: fresh.id }); navigate(`/panel/tasks/${fresh.id}?m=${moduleKey}`) }
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' })
    } finally { setBusy(false) }
  }

  // §9.8: правка задачи — только на паузе (сервер это тоже проверяет и вернёт 409).
  const [editing, setEditing] = useState(false)
  const [edTargets, setEdTargets] = useState('')
  // Лимиты держим СТРОКАМИ: пустая строка = «не задано». Раньше здесь были числа и
  // `s.maxActions ?? 0`, поэтому незаданный лимит показывался нулём; оператор принимал
  // ноль за настоящее значение, жал «Сохранить» — и в настройки уходил явный 0, который
  // resolveTotalTarget трактует как «ноль действий» (прогон 21–22.07, тест 6.4).
  const [edMinActions, setEdMinActions] = useState('')
  const [edMaxActions, setEdMaxActions] = useState('')
  const [edMinPerAcc, setEdMinPerAcc] = useState('')
  const [edMaxPerAcc, setEdMaxPerAcc] = useState('')
  // ВАЖНО: хук объявлен здесь, до ранних return'ов. Порядок хуков в React обязан быть
  // одинаковым на каждом рендере — useState после условного return роняет всю страницу
  // в белый/чёрный экран, как только задача догрузится.
  const RES_PER_PAGE = 50
  const [resPage, setResPage] = useState(1)

  const startEdit = (s: ModuleTaskSettings) => {
    setEdTargets((s.channels || s.targets || []).join('\n'))
    const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
    setEdMinActions(str(s.minActions))
    setEdMaxActions(str(s.maxActions))
    setEdMinPerAcc(str(s.minPerAccount))
    setEdMaxPerAcc(str(s.maxPerAccount))
    setEditing(true)
  }

  const saveEdit = async () => {
    const targets = edTargets.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    // Пустое поле НЕ отправляем — иначе «не задано» превратится в явный 0.
    const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Number(v) || 0))
    await run(
      () => updateModuleTaskSettings(moduleKey, id, {
        targets, channels: targets,
        minActions: num(edMinActions), maxActions: num(edMaxActions),
        minPerAccount: num(edMinPerAcc), maxPerAccount: num(edMaxPerAcc),
      }),
      'Настройки задачи обновлены',
    )
    setEditing(false)
  }

  const back = (
    <button onClick={() => navigate('/panel/tasks')} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к задачам</button>
  )

  if (!task) {
    return (
      <div>
        {back}
        <Card className="p-6 text-sm text-white/50">{notFound ? 'Задача не найдена. Возможно, она была удалена, или бэкенд перезапущен.' : 'Загрузка…'}</Card>
      </div>
    )
  }

  const t = task
  // Право на управление — по модулю задачи. Тот же критерий, что в списке.
  const canControl = !me || canControlModule(me.permissions, me.isAdmin, t.moduleKey)
  const st = STATUS[t.status] || { label: t.status, tone: 'muted' as const }
  const p = pct(t)
  const s = t.settings || {}
  const logs = (t.logs || []).slice(0, 300)
  const results = (t.results || t.commentHistory || []) as Record<string, unknown>[]
  const resPages = Math.max(1, Math.ceil(results.length / RES_PER_PAGE))

  return (
    <div>
      {back}
      <PageHeader
        title={`${moduleTitle(t.moduleKey)}`}
        subtitle={`Задача #${t.id} · ${t.initiator || 'ручной запуск'}`}
        icon={<ListChecks size={22} />}
      />
      <div className="space-y-4">
        <div className="flex items-center gap-4 rounded-2xl border border-line bg-elevated/40 p-4">
          <Ring value={p} color={STATUS_COLOR[t.status] || '#94a3b8'} size={66} stroke={6} pulse={isActive(t)} />
          <div className="min-w-0 flex-1">
            <Badge tone={st.tone}>{st.label}</Badge>
            <div className="mt-1 text-sm text-white/60">{t.progress?.done ?? t.progress?.actionsDone ?? 0} / {t.progress?.total ?? 0} действий</div>
          </div>
          {/* Управление — только тем, у кого есть доступ к модулю задачи. */}
          <div className="flex shrink-0 gap-1">
            {canControl && isActive(t) && <button onClick={doPause} disabled={busy} className="btn-icon h-9 w-9" title="Пауза"><Pause size={15} /></button>}
            {canControl && t.status === 'paused' && <button onClick={doResume} disabled={busy} className="btn-icon h-9 w-9 text-spark-400" title="Продолжить"><Play size={15} /></button>}
            {canControl && isActive(t) && <button onClick={doStop} disabled={busy} className="btn-icon h-9 w-9 text-rose-300" title="Стоп"><Square size={15} /></button>}
            {/* §9.8: правка только на паузе. Кнопку показываем всегда, но у работающей
                задачи она заблокирована и объясняет причину — так понятнее, чем её отсутствие.
                А вот без доступа к модулю её нет вовсе: это не «пока нельзя», а «нельзя». */}
            {canControl && <button
              onClick={() => startEdit(s)}
              disabled={busy || t.status !== 'paused'}
              className="btn-icon h-9 w-9 disabled:opacity-40"
              title={t.status === 'paused'
                ? 'Редактировать настройки задачи'
                : isActive(t)
                  ? 'Править можно только на паузе: сейчас задача выполняется и часть аккаунтов уже отработала по текущим настройкам'
                  : 'Задача завершена — править нечего, перезапустите её'}
            ><Pencil size={15} /></button>}
            {canControl && <button onClick={doRestart} disabled={busy} className="btn-icon h-9 w-9" title="Перезапуск"><RotateCw size={16} /></button>}
          </div>
        </div>

        {/* Причина блокировки правки — ТЕКСТОМ, а не в title кнопки: браузеры не показывают
            подсказки на disabled-элементах (они не получают событий мыши), поэтому оператор
            видел «не могу нажать» и ни намёка почему (прогон 21–22.07, тест 6.3). */}
        {t.status !== 'paused' && (
          <div className="mt-2 text-xs text-muted">
            {isActive(t)
              ? 'Настройки задачи правятся только на паузе — сейчас она выполняется, и часть аккаунтов уже отработала по текущим настройкам. Нажмите «Пауза», затем карандаш.'
              : 'Задача завершена — править нечего. Нажмите «Перезапуск», чтобы создать новую с этими настройками.'}
          </div>
        )}

        {editing && (
          <div className="rounded-2xl border border-spark-500/40 bg-spark-500/5 p-4">
            <div className="mb-3 text-sm font-bold text-fg">Правка задачи (на паузе)</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-white/50 sm:col-span-2">Каналы / чаты — по одному на строку
                <textarea value={edTargets} onChange={(e) => setEdTargets(e.target.value)} className="input mt-1 min-h-[80px] font-mono text-sm" placeholder="@channel" />
              </label>
              <label className="text-xs text-white/50">Всего действий: от
                <input type="number" min={0} value={edMinActions} onChange={(e) => setEdMinActions(e.target.value)} placeholder="не задано" className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">до
                <input type="number" min={0} value={edMaxActions} onChange={(e) => setEdMaxActions(e.target.value)} placeholder="не задано" className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">На аккаунт: от
                <input type="number" min={0} value={edMinPerAcc} onChange={(e) => setEdMinPerAcc(e.target.value)} placeholder="не задано" className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">до
                <input type="number" min={0} value={edMaxPerAcc} onChange={(e) => setEdMaxPerAcc(e.target.value)} placeholder="не задано" className="input mt-1 h-9" />
              </label>
            </div>
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Состав аккаунтов здесь не меняется: за задачей держатся блокировки профилей. Нужны другие
              исполнители — остановите задачу и создайте новую.
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => void saveEdit()} disabled={busy} className="btn-primary h-9">Сохранить</button>
              <button onClick={() => setEditing(false)} disabled={busy} className="btn-ghost h-9">Отмена</button>
            </div>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <Info label="Модуль" value={moduleTitle(t.moduleKey)} />
          {/* §8: разводим «цель кампании» (Goal) и «каналы, куда идёт работа» — раньше путались. */}
          <Info label="Кампания" value={t.campaignId ? (campaignsList.find((c) => c.id === t.campaignId)?.name || t.campaignId) : 'без кампании'} />
          <Info label="Цель кампании" value={goalName(t.goalId) || 'без цели'} />
          <Info label="Инициатор" value={t.initiator || '—'} />
          <Info label="Аккаунтов" value={String((s.accountIds || []).length)} />
          <Info label="Каналов / чатов" value={String((s.channels || s.targets || []).length)} />
          <Info label="На аккаунт" value={`${s.minPerAccount ?? 0}–${s.maxPerAccount ?? 0}`} />
          <Info label="Создана" value={new Date(t.createdAt).toLocaleString('ru-RU')} />
          <Info label="Обновлена" value={new Date(t.updatedAt).toLocaleString('ru-RU')} />
          <Info label="Результатов" value={String(results.length)} />
          {/* §10.1: полная цена запуска = действия + токены ИИ. Раньше показывали только
              spentCoins (действия), а монеты за токены списывались отдельно и в сумму не
              входили — «Потрачено» выходило заниженным. Разбивку даём в подписи. */}
          <Info
            label="Потрачено"
            value={`${fmtCoins((t.spentCoins || 0) + (t.tokenCoins || 0))} ⚡${t.tokens ? ` · ${t.tokens.toLocaleString('ru-RU')} токенов` : ''}`}
            hint={t.tokenCoins ? `${fmtCoins(t.spentCoins || 0)} ⚡ за действия + ${fmtCoins(t.tokenCoins)} ⚡ за ИИ` : undefined}
          />
        </div>

        <ChipList
          title="Аккаунты в работе"
          count={(s.accountIds || []).length}
          items={(s.accountIds || []).map((aid) => accountName(aid))}
          empty="Аккаунты не заданы"
          tone="iris"
        />
        <ChipList
          title="Каналы / чаты — где работает модуль"
          count={(s.channels || s.targets || []).length}
          items={(s.channels || s.targets || []).map((c) => (c.startsWith('@') || c.startsWith('http') ? c : `@${c}`))}
          empty="Каналы не заданы (модуль работает без списка)"
          tone="spark"
          mono
        />
        {(s.postUrls?.length ?? 0) > 0 && (
          <ChipList title="Ссылки на посты" count={s.postUrls!.length} items={s.postUrls!} empty="" tone="spark" mono />
        )}

        {/* §9.11: кому написали и кто остался — только там, где это осмысленно (рассылка). */}
        {t.moduleKey === 'mailing' && <TaskAudiencePanel moduleKey={t.moduleKey} taskId={t.id} />}

        {results.length > 0 && (
          <div className="rounded-2xl border border-line bg-elevated/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-bold text-fg">Результаты ({results.length})</span>
              {/* §3.9: тот же экспорт, что в самом парсере — результаты задачи нужны
                  так же часто, как «свежие» на экране модуля. */}
              <button
                type="button"
                onClick={() => downloadXls(results, `${t.moduleKey}-${t.id}`)}
                className="btn-soft ml-auto h-8 text-xs"
              >
                <Download size={13} /> Excel
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {/* §8: для AIR (проверка аккаунтов) — понятный рейтинг по каждому аккаунту, а не сырой лог. */}
              {t.moduleKey === 'ggr' ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-1.5">Аккаунт</th><th className="w-40">Балл</th><th className="w-28 text-right">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...results]
                      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
                      .slice(0, 200)
                      .map((r, i) => {
                        const score = Number(r.score) || 0
                        const valid = r.status === 'valid'
                        const color = score >= 70 ? '#0ec464' : score >= 40 ? '#f59e0b' : '#f43f5e'
                        return (
                          <tr key={i} className="border-b border-line/50">
                            <td className="py-1.5 font-medium text-fg">
                              {String(r.name ?? r.accountName ?? r.username ?? '—')}
                              {r.username ? <span className="ml-1 text-xs text-muted">@{String(r.username)}</span> : null}
                            </td>
                            <td>
                              <div className="flex items-center gap-2">
                                <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
                                  <span className="block h-full rounded-full" style={{ width: `${Math.min(100, score)}%`, background: color }} />
                                </span>
                                <span className="font-mono text-xs font-bold" style={{ color }}>{score}</span>
                              </div>
                            </td>
                            <td className="text-right">
                              <Badge tone={valid ? 'spark' : 'rose'}>{valid ? 'валиден' : String(r.status ?? 'невалиден')}</Badge>
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-1.5">Имя</th>
                      <th className="w-44">Юзернейм</th>
                      <th className="w-48">Откуда</th>
                      <th className="w-24 text-right">Тип</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.slice((resPage - 1) * RES_PER_PAGE, resPage * RES_PER_PAGE).map((r, i) => (
                      <tr key={i} className="border-b border-line/50">
                        <td className="py-1.5 font-medium text-fg">{String(r.name ?? r.title ?? r.accountName ?? '—')}</td>
                        <td className="font-mono text-xs text-muted">
                          {r.username
                            ? <a href={`https://t.me/${String(r.username)}`} target="_blank" rel="noreferrer" className="hover:text-spark-300">@{String(r.username)}</a>
                            : <span className="text-white/25">—</span>}
                        </td>
                        {/* §3.9: откуда спаршен — при пачке целей без этого результат превращается в кашу. */}
                        <td className="truncate text-xs text-white/45">{String(r.source ?? r.comment ?? r.text ?? '')}</td>
                        <td className="text-right"><span className="text-xs text-white/40">{String(r.status ?? r.kind ?? '')}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* Пагинация — как в парсере: 200 первых строк «на глаз» скрывали остальное. */}
            {t.moduleKey !== 'ggr' && resPages > 1 && (
              <div className="mt-2 flex items-center justify-center gap-2 text-xs">
                <button onClick={() => setResPage((p) => Math.max(1, p - 1))} disabled={resPage === 1} className="btn-soft h-7 px-2 disabled:opacity-30">Назад</button>
                <span className="text-muted">{resPage} / {resPages}</span>
                <button onClick={() => setResPage((p) => Math.min(resPages, p + 1))} disabled={resPage === resPages} className="btn-soft h-7 px-2 disabled:opacity-30">Вперёд</button>
                <span className="ml-2 text-white/30">по {RES_PER_PAGE} из {results.length}</span>
              </div>
            )}
          </div>
        )}

        <div className="rounded-2xl border border-line bg-elevated/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg">Логи ({(t.logs || []).length}){isActive(t) && <Loader2 size={13} className="animate-spin text-white/40" />}</div>
          {logs.length === 0 ? (
            <div className="py-3 text-center text-xs text-white/40">Логов пока нет</div>
          ) : (
            <div className="max-h-96 space-y-1 overflow-y-auto">
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
    </div>
  )
}
