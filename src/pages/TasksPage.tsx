import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ListChecks, RefreshCw, Square, RotateCw, Target, Activity, Gauge, Pause, Play, Loader2, ArrowLeft, Download, AlertTriangle, Clock, Hourglass } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select, Tip} from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { MODULES, isCombatModule, combatConfirmText } from '@/shared/config/modules'
import { fetchAllTasks, fetchModuleTask, stopModuleTask, restartModuleTask, pauseModuleTask, resumeModuleTask, updateModuleTaskSettings, type ModuleTask } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'
import { fetchAccounts } from '@/api/accountsApi'
import { fetchActivity, type ActivityMap } from '@/api/accountActivityApi'
import { fetchConcurrency, saveSettings, type ConcurrencyState } from '@/api/settingsApi'
import type { TgAccount } from '@/shared/types'
import { cn, coins as fmtCoins } from '@/shared/lib/utils'
import { confirmDialog, promptDialog } from '@/shared/lib/dialog'
import { TaskAudiencePanel } from '@/features/mailing/TaskAudiencePanel'
import { launchWithSkip } from '@/features/modules/shared/launchWithSkip'
import { massStopConfirmSteps, canStopWarming, containsWarming } from '@/shared/lib/massAction'
import { useSession } from '@/features/auth/session'
import { canControlModule } from '@/shared/lib/access'
import { downloadXls } from '@/shared/lib/exportXls'
import { useTabParam } from '@/shared/lib/useTabParam'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { PRESET_MUL } from '@/features/modules/shared/TimingSection'

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
const STATUS_KEYS = ['', 'running', 'queued', 'stopped', 'error', 'done']
// Порядок сортировки/фильтров (MR-147): выполняется→в очереди→(пауза)→остановлено→ошибка→готово.
const STATUS_RANK: Record<string, number> = {
  running: 0, queued: 1, paused: 2, stopped: 3, error: 4, done: 5,
}
const statusRank = (t: ModuleTask) => STATUS_RANK[t.status] ?? 9

// mailing/autoposting — отдельные страницы, их нет в MODULES; задаём читаемые названия.
const EXTRA_MODULE_TITLES: Record<string, string> = { mailing: 'Мейлинг', autoposting: 'Автопостинг' }
function moduleTitle(key: string) { return MODULES[key]?.title || EXTRA_MODULE_TITLES[key] || key }
function pct(t: ModuleTask) {
  const total = t.progress?.total || 0
  const done = t.progress?.done ?? t.progress?.actionsDone ?? 0
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}
const isActive = (t: ModuleTask) => t.status === 'running' || t.status === 'queued'

// MR-109 (ТЗ 06.08, TASK-001): ETA — сколько ещё бежать РАБОТАЮЩЕЙ задаче.
//
// Считаем НЕ по факту (прошедшее время / сделано): задачу могли создать вчера, поставить
// на паузу и возобновить сегодня — тогда «прошедшее время» это сутки простоя, а не работы,
// и ETA получался бы абсурдным («≈ 24 ч» на прогрев из двух действий). Считаем по ТЕМПУ
// самого модуля — так же, как оценка времени в панели ДО запуска (§10.1), она стабильна и
// не зависит от пауз воркера:
//  - прогрев меряется днями: уровень задаёт «действий/день на аккаунт» (см. ниже);
//  - остальные модули — «остаток действий × средняя задержка между действиями».
// Остаток делится между аккаунтами: они работают параллельно. Показываем только у running
// и только когда есть чем считать; иначе null (не врём «0 с»).

// Прогрев: уровень → действий/день на аккаунт. ДОЛЖНО совпадать с сервером
// (server/lib/workerLoop.js warmingPace: 0→40, 1→20, 2→10).
const WARM_ACTIONS_PER_DAY = [40, 20, 10]
// Дефолтная задержка между действиями, сек — та же, что в LiveModule DEFAULT_DELAYS.action.
// Нужна как запасной темп для СТАРЫХ задач, у которых в settings задержки не сохранены
// (тогда без фолбэка ETA не считался вовсе). У свежих задач задержки свои — берутся они.
const DEFAULT_ACTION_DELAY: [number, number] = [30, 120]

// Статусы, для которых ETA имеет смысл: работа ещё не завершена. У running — время до
// конца, у queued/paused/stopped — прогноз «при запуске». done/error — считать нечего.
const ETA_STATUSES = new Set(['running', 'queued', 'paused', 'stopped'])
/**
 * Усталость аккаунтов задачи: через сколько действий уходят на отдых, насколько долго и
 * когда вернутся те, кто отдыхает прямо сейчас. Считается по РЕАЛЬНЫМ профилям аккаунтов
 * (правка 19.08) — до этого ETA обещал «≈ 1 мин» задаче, которой предстояло два часа
 * пережидать отдых, и число выглядело издевательством.
 */
export interface FatigueHint { threshold: number; restMs: number; restingUntil: number }
function taskEtaMs(t: ModuleTask, fatigue?: FatigueHint | null): number | null {
  if (!ETA_STATUSES.has(t.status)) return null
  const done = t.progress?.done ?? t.progress?.actionsDone ?? 0
  const total = t.progress?.total ?? 0
  if (total <= done) return null
  const s = t.settings || {}
  const accounts = Math.max(1, (s.accountIds || []).length)
  const perAccRemaining = Math.ceil((total - done) / accounts)
  // Прогрев: темп задаётся уровнем в действиях/день, а не задержкой между действиями.
  if (t.moduleKey === 'warming') {
    const perDay = WARM_ACTIONS_PER_DAY[s.warmLevel ?? 1] ?? 20
    return perDay > 0 ? Math.round((perAccRemaining / perDay) * 86400 * 1000) : null
  }
  // Остальные модули: остаток × средняя задержка (та же формула, что в панели до запуска).
  // Нет сохранённых задержек (старая задача) — берём дефолтный темп модуля, чтобы ETA
  // всё же показать примерным, а не прятать его совсем.
  const d = s.delays?.action ?? s.delays?.comment ?? DEFAULT_ACTION_DELAY
  const mul = PRESET_MUL[s.delayPreset ?? 1] ?? 1
  const avgDelaySec = ((d[0] + d[1]) / 2) * mul
  if (avgDelaySec <= 0) return null
  let ms = Math.round(perAccRemaining * avgDelaySec * 1000)

  // Отдых аккаунтов — часть времени задачи, а не помеха ему. Сколько раз аккаунт успеет
  // упереться в порог на оставшихся действиях, столько отдыхов и добавляем; плюс тот,
  // что идёт прямо сейчас.
  if (fatigue && fatigue.threshold > 0 && fatigue.restMs > 0) {
    const rests = Math.floor(perAccRemaining / fatigue.threshold)
    ms += rests * fatigue.restMs
    if (fatigue.restingUntil > Date.now()) ms += fatigue.restingUntil - Date.now()
  }
  return ms
}

/** Секунды → человекочитаемо: «45 с», «12 мин», «6 ч 20 мин», «5 дн 4 ч» (как в панели запуска). */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} с`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm ? `${h} ч ${rm} мин` : `${h} ч`
  const dd = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${dd} дн ${rh} ч` : `${dd} дн`
}

/** Проблемные аккаунты задачи: сколько, из скольких и ЧТО именно не так у каждого. */
type TaskProblem = { bad: number; total: number; items: { name: string; reason: string }[] }

// MR-146: «отвалившийся» аккаунт задачи — по тем же признакам, что в менеджере/пикере.
// Возвращает короткую причину проблемы или '' если аккаунт в порядке.
function acctProblem(a?: TgAccount): string {
  if (!a) return 'нет в системе'
  if (!a.proxy || a.proxy === '—') return 'нет прокси'
  if (a.proxyOk === false) return 'прокси не отвечает'
  if (a.status === 'reauth') return 'нужна переавторизация'
  if (a.status === 'invalid') return 'невалиден'
  if (a.status === 'spamblock') return 'спамблок'
  if (a.status === 'quarantine') return 'карантин'
  return ''
}

// «Стоп»/«Пауза» лишь ПРОСЯТ воркера остановиться — фактически он выходит из цикла
// позже (доделав текущее действие). Достигла ли задача ожидаемого состояния?
const isTerminal = (t: ModuleTask) => t.status === 'stopped' || t.status === 'done' || t.status === 'error'
function actionSettled(t: ModuleTask, action: 'pause' | 'stop') {
  return action === 'stop' ? isTerminal(t) : t.status === 'paused' || isTerminal(t)
}
// Страховка: если воркер завис и статус не меняется — не держим кнопки вечно.
const PENDING_TIMEOUT_MS = 30000

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
  // MR-146: аккаунты для warning-системы. Грузим ОТДЕЛЬНО и редко (раз в 60с), а не в 5с-поллинге
  // задач — здоровье аккаунтов не меняется ежесекундно, лишний трафик на дашборде не нужен.
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  // MR-144: состояние очереди (running/waiting/max) + редактирование лимита владельцем.
  const [conc, setConc] = useState<ConcurrencyState | null>(null)
  const [limitEdit, setLimitEdit] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  // MR-130: какое ИМЕННО действие идёт по busy-задаче — чтобы крутить лоадер на нажатой
  // кнопке (Play/Pause/Stop), а не просто гасить все три. Пока действие не «сядет»
  // (статус не сменится после load), нельзя слать повторные паузы/стопы.
  const [busyAction, setBusyAction] = useState<'start' | 'pause' | 'stop' | null>(null)
  // Задачи «в процессе остановки/паузы»: кнопки заблокированы и статус «Останавливается…»,
  // пока воркер реально не встанет. Раньше блокировка снималась сразу после ответа сервера
  // (~100мс) — статус ещё «running», можно было спамить стоп, а тост «Остановлена» врал.
  const [pending, setPending] = useState<Record<string, { action: 'pause' | 'stop'; at: number }>>({})
  const clearPending = (id: string) => setPending((p) => { if (!p[id]) return p; const n = { ...p }; delete n[id]; return n })
  const [view] = useTabParam<number>(0, 'view') // 0 — список, 1 — по целям (воронка)
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
      void fetchConcurrency().then(setConc).catch(() => {}) // MR-144: не блокирует список задач
      // Снимаем «в процессе» с задач, которые реально встали (или пропали / зависли).
      setPending((prev) => {
        const ids = Object.keys(prev)
        if (!ids.length) return prev
        const now = Date.now()
        const next: typeof prev = {}
        for (const id of ids) {
          const ft = t.find((x) => x.id === id)
          const stale = now - prev[id].at > PENDING_TIMEOUT_MS
          if (ft && !actionSettled(ft, prev[id].action) && !stale) next[id] = prev[id]
        }
        return next
      })
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить задачи', desc: err instanceof Error ? err.message : '' })
    } finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    const id = setInterval(() => { void load() }, 5000)
    return () => clearInterval(id)
  }, [])
  // MR-146: аккаунты — отдельным редким циклом.
  useEffect(() => {
    const loadAcc = () => void fetchAccounts().then(setAccounts).catch(() => {})
    loadAcc()
    const id = setInterval(loadAcc, 60000)
    return () => clearInterval(id)
  }, [])
  // Усталость аккаунтов — для честного ETA: задача, которой предстоит два часа отдыха,
  // не должна обещать «≈ 1 мин» (правка 19.08).
  const [activity, setActivity] = useState<ActivityMap>({})
  useEffect(() => {
    const loadAct = () => void fetchActivity().then(setActivity).catch(() => {})
    loadAct()
    const id = setInterval(loadAct, 60000)
    return () => clearInterval(id)
  }, [])
  /** Профиль усталости задачи: берём самый «тяжёлый» среди её аккаунтов. */
  const fatigueOf = useMemo(() => (t: ModuleTask): FatigueHint | null => {
    const rows = (t.settings?.accountIds || []).map((id) => activity[id]).filter((a) => a?.threshold)
    if (!rows.length) return null
    // Берём самый «тяжёлый» отдых по задаче и самый поздний возврат: ETA не должен быть
    // оптимистичнее реальности, иначе он снова обманет.
    const worst = rows.reduce((acc, a) => (Number(a.restMinutes) || 0) > (Number(acc.restMinutes) || 0) ? a : acc, rows[0])
    const restingUntil = rows.reduce((mx, a) => (a.resting && a.restUntil > mx ? a.restUntil : mx), 0)
    return { threshold: worst.threshold, restMs: Math.max(0, Number(worst.restMinutes) || 0) * 60000, restingUntil }
  }, [activity])
  // MR-146: на каждую задачу — сколько её аккаунтов «отвалилось» (нет прокси/не отвечает/нерабочий статус).
  const acctById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const taskProblems = useMemo(() => {
    const fn = (t: ModuleTask): TaskProblem => {
      const ids = t.settings?.accountIds || []
      // Пока список аккаунтов не загрузился — НЕ судим (иначе первые ~60с все задачи
      // мигали бы ложным «все аккаунты с проблемой», т.к. byId ещё пуст).
      if (acctById.size === 0) return { bad: 0, total: ids.length, items: [] }
      // Собираем не только счётчик, но и ПРИЧИНУ по каждому аккаунту: «нет прокси» и
      // «нужна переавторизация» чинятся по-разному, а раньше показывался общий текст
      // со списком всех возможных причин сразу — читать его было бесполезно.
      const items: { name: string; reason: string }[] = []
      for (const id of ids) {
        const a = acctById.get(id)
        const reason = acctProblem(a)
        if (reason) items.push({ name: a ? (a.name || a.username || a.phone || id) : id, reason })
      }
      return { bad: items.length, total: ids.length, items }
    }
    return fn
  }, [acctById])
  // Пока есть задачи «в процессе» — опрашиваем чаще, чтобы кнопки разблокировались и
  // статус обновился сразу, как воркер встанет (а не через общий 5-секундный цикл).
  const hasPending = Object.keys(pending).length > 0
  useEffect(() => {
    if (!hasPending) return
    const id = setInterval(() => { void load() }, 1200)
    return () => clearInterval(id)
  }, [hasPending])

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
    // Держим «в процессе» до фактической остановки — снимется в load(), когда статус
    // станет терминальным. Кнопки блокируются по pending, а не по короткому busy.
    setPending((p) => ({ ...p, [t.id]: { action: 'stop', at: Date.now() } }))
    setBusy(t.id); setBusyAction('stop')
    try { await stopModuleTask(t.moduleKey, t.id); pushToast({ type: 'info', title: 'Останавливаю задачу…', desc: 'Воркер завершает текущее действие' }); await load() }
    catch (err) { clearPending(t.id); pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null); setBusyAction(null) }
  }
  const doRestart = async (t: ModuleTask) => {
    // #4: рестарт боевого модуля = реальные действия в Telegram — подтверждаем.
    if (isCombatModule(t.moduleKey) && !(await confirmDialog({ title: 'Реальные действия в Telegram', message: combatConfirmText(t.moduleKey), confirmLabel: 'Запустить', tone: 'danger' }))) return
    setBusy(t.id); setBusyAction('start')
    // Часть аккаунтов в карантине/спамблоке — не валим запуск, а предлагаем без них.
    // Рестарт создаёт НОВУЮ задачу, старая остаётся «Остановлена» — говорим об этом
    // явно, иначе выглядит как «ничего не произошло» (тест 6.2).
    try {
      const fresh = await launchWithSkip((skip) => restartModuleTask(t.moduleKey, t.id, skip))
      if (fresh) { pushToast({ type: 'success', title: 'Создана новая задача', desc: `${fresh.id} — прежняя ${t.id} осталась остановленной` }); await load() }
    }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка перезапуска', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null); setBusyAction(null) }
  }
  const doPause = async (t: ModuleTask) => {
    setPending((p) => ({ ...p, [t.id]: { action: 'pause', at: Date.now() } }))
    setBusy(t.id); setBusyAction('pause')
    try { await pauseModuleTask(t.moduleKey, t.id); pushToast({ type: 'info', title: 'Ставлю на паузу…', desc: 'Воркер завершает текущее действие' }); await load() }
    catch (err) { clearPending(t.id); pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null); setBusyAction(null) }
  }
  const doResume = async (t: ModuleTask) => {
    setBusy(t.id); setBusyAction('start')
    try { await resumeModuleTask(t.moduleKey, t.id); pushToast({ type: 'success', title: 'Задача продолжена' }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка продолжения', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null); setBusyAction(null) }
  }

  // ── Массовый выбор задач + действия над выбранными ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const runBulk = async (label: string, targets: ModuleTask[], fn: (t: ModuleTask) => Promise<unknown>, pendingAction?: 'pause' | 'stop') => {
    if (!targets.length) { pushToast({ type: 'info', title: 'Нет подходящих задач', desc: label }); return }
    // Массовый стоп/пауза: помечаем ВСЕ выбранные «в процессе» разом и бьём по ним
    // ПАРАЛЛЕЛЬНО — «выбрал коробку, убил — все встали моментально», а не по одной.
    if (pendingAction) {
      const at = Date.now()
      setPending((p) => { const n = { ...p }; for (const t of targets) n[t.id] = { action: pendingAction, at }; return n })
    }
    setBusy('bulk')
    const results = await Promise.allSettled(targets.map((t) => fn(t)))
    // Собираем ПРИЧИНЫ по каждой упавшей задаче — иначе «ошибок 2» ни о чём не говорит.
    const failures = results.flatMap((r, i) => r.status === 'rejected'
      ? [{ t: targets[i], msg: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
      : [])
    const ok = results.length - failures.length
    // Снимаем «в процессе» только с тех, где сам запрос упал; остальные снимутся в load()
    // по факту остановки воркера.
    if (pendingAction && failures.length) {
      setPending((p) => { const n = { ...p }; failures.forEach((f) => delete n[f.t.id]); return n })
    }
    setBusy(null)
    setSelected(new Set())
    await load()
    // Успех и ошибки — РАЗНЫМИ тостами, ошибки с причиной по каждой задаче.
    if (ok) pushToast({ type: 'success', title: `${label}: ${ok} задач${failures.length ? '' : ''}` })
    if (failures.length) {
      const lines = failures.slice(0, 6).map((f) => `${moduleTitle(f.t.moduleKey)} ${f.t.id} — ${f.msg}`).join('\n')
      pushToast({
        type: 'error',
        title: `Не удалось: ${failures.length} задач${ok ? ` (успешно ${ok})` : ''}`,
        desc: lines + (failures.length > 6 ? `\n…и ещё ${failures.length - 6}` : ''),
      })
    }
  }

  const modules = useMemo(() => [...new Set(tasks.map((t) => t.moduleKey))], [tasks])
  const filtered = useMemo(() => tasks.filter((t) =>
    (!fGoal || (fGoal === 'none' ? !t.goalId : t.goalId === fGoal)) &&
    (!fModule || t.moduleKey === fModule) &&
    (!fStatus || t.status === fStatus),
  // MR-147: сортировка по статусу (выполняется→очередь→пауза→стоп→ошибка→готово),
  // внутри статуса — свежие сверху.
  ).sort((a, b) => statusRank(a) - statusRank(b) || (b.updatedAt || 0) - (a.updatedAt || 0)),
  [tasks, fGoal, fModule, fStatus])

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
    // paused/stopped — ПРОДОЛЖАЕМ ту же задачу с места (resume, прогресс сохранён);
    // done/error — restart (новая задача с нуля). Подтверждение боевого модуля нужно
    // только для настоящего перезапуска-с-нуля, не для продолжения.
    const isResume = (t: ModuleTask) => t.status === 'paused' || t.status === 'stopped'
    if (startTargets.some((t) => !isResume(t) && isCombatModule(t.moduleKey)) &&
        !(await confirmDialog({ title: 'Реальные действия в Telegram', message: 'Перезапуск боевых модулей выполнит реальные действия в Telegram (комментарии / ответы / реакции). Продолжить?', confirmLabel: 'Запустить', tone: 'danger' }))) return
    // Массовый запуск: недоступные аккаунты исключаем сразу. Спрашивать по каждой
    // задаче отдельно — двадцать одинаковых вопросов подряд, никто так не работает.
    void runBulk('Запуск/возобновление', startTargets, (t) => (isResume(t) ? resumeModuleTask(t.moduleKey, t.id) : restartModuleTask(t.moduleKey, t.id, true)))
  }
  const bulkPause = () => void runBulk('Пауза', pauseTargets, (t) => pauseModuleTask(t.moduleKey, t.id), 'pause')
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
    void runBulk('Стоп', stopTargets, (t) => stopModuleTask(t.moduleKey, t.id), 'stop')
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

  // MR-144: владелец/админ меняет лимит параллельных задач прямо с дашборда.
  const canEditLimit = !me || me.isAdmin || me.isOwner
  const saveLimit = async () => {
    const n = Math.max(1, Math.min(20, Math.round(Number(limitEdit)) || (conc?.max ?? 3)))
    try {
      await saveSettings({ maxParallelTasks: n })
      setLimitEdit(null)
      void fetchConcurrency().then(setConc).catch(() => {})
      pushToast({ type: 'success', title: 'Лимит обновлён', desc: `Одновременно выполняется до ${n} задач` })
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось изменить лимит', desc: e instanceof Error ? e.message : '' }) }
  }

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
        subtitle="Задачи и модули: единый экран прогресса, статусов и запуска."
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

        {/* Плашка «Целей в работе» скрыта (правка 13.08): целей нет, счётчик вечно 0 и
            занимал четверть блока. Метрика жива в funnel — вернуть = одна строка. */}
        <div className="grid grid-cols-2 gap-2">
          {stat(<ListChecks size={17} />, 'Задач (в фильтре)', funnel.tasks)}
          {stat(<Activity size={17} />, 'Активных / модулей', `${funnel.active} / ${funnel.modulesWorking}`, 'text-amber-300')}
          {stat(<Gauge size={17} />, 'Средний прогресс', `${funnel.avg}%`)}
        </div>
      </div>

      {/* MR-144: лимит параллельных задач — значение на дашборде + правка владельцем/админом. */}
      {conc && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-line bg-elevated/40 px-4 py-2.5 text-sm">
          <Activity size={15} className="text-amber-300" />
          <span className="text-white/70">Параллельно задач:</span>
          <span className="font-bold tabular-nums text-fg">{conc.running} / {conc.max}</span>
          {conc.waiting > 0 && <span className="text-white/40">· {conc.waiting} в очереди</span>}
          {canEditLimit && (limitEdit === null ? (
            <button onClick={() => setLimitEdit(String(conc.max))} className="btn-ghost ml-auto h-8 text-xs">Изменить лимит</button>
          ) : (
            <span className="ml-auto flex items-center gap-1.5">
              <input type="number" min={1} max={20} value={limitEdit} onChange={(e) => setLimitEdit(e.target.value)} className="input h-8 w-20" autoFocus />
              <button onClick={() => void saveLimit()} className="btn-primary h-8 text-xs">Сохранить</button>
              <button onClick={() => setLimitEdit(null)} className="btn-ghost h-8 text-xs">Отмена</button>
            </span>
          ))}
        </div>
      )}

      {/* Фильтры + режим */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Переключатель «Список / По целям» скрыт (правка 13.08): целей в работе обычно
            нет, и вкладка «По целям» стояла пустой, занимая место. Сам разрез не удалён —
            открывается по ссылке ?view=1, чтобы вернуть его одной строкой, когда цели пойдут. */}
        {/* Фильтр по целям скрыт вместе с плашкой: фильтровать нечего, пока целей нет.
            Сам фильтр рабочий — показываем, как только цель появится. */}
        {goals.length > 0 && (
          <Select value={fGoal} onChange={setFGoal} className="w-48" options={[{ value: '', label: 'Все цели' }, { value: 'none', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
        )}
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
            <BulkBtn onClick={bulkStart} disabled={busy !== null || hasPending || startTargets.length === 0} tone="green" icon={<Play size={13} />} label="Запустить / возобновить" count={startTargets.length} />
            <BulkBtn onClick={bulkPause} disabled={busy !== null || hasPending || pauseTargets.length === 0} tone="amber" icon={<Pause size={13} />} label="Пауза" count={pauseTargets.length} />
            <BulkBtn onClick={() => void bulkStop()} disabled={busy !== null || hasPending || stopTargets.length === 0} tone="rose" icon={<Square size={13} />} label="Стоп" count={stopTargets.length} />
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
              {/* Тот же приём внутри цели: строки + равная высота, порядок слева направо. */}
              <div className="mt-2 grid items-stretch gap-1.5 sm:grid-cols-2">
                {g.tasks.map((t) => <div key={`${t.moduleKey}:${t.id}`} className="min-w-0"><TaskCard t={t} goalName={null} busy={busy} busyAction={busyAction} pendingAction={pending[t.id]?.action} onOpen={openTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} canControl={canControl(t)} problem={taskProblems(t)} fatigue={fatigueOf(t)} compact /></div>)}
              </div>
            </Card>
          ))}
        </div>
        )
      ) : (
        // Раскладка: СТРОКИ, порядок слева направо (правка 18.08, вторая итерация).
        //
        // Колонки укладывали карточки без дыр, но ломали чтение: правая колонка
        // начинается с СЕРЕДИНЫ списка, и отсортированный по статусу дашборд выглядит
        // перемешанным. Порядок здесь важнее плотности — по нему ищут задачу.
        //
        // Дыры убраны иначе: карточки в строке тянутся до общей высоты (`items-stretch`
        // у грида + `h-full` у карточки). Пустое место оказывается ВНУТРИ карточки, под
        // её фоном, а не провалом между блоками — визуально это ровная сетка, а не
        // рваная кладка.
        <div className="grid items-stretch gap-2 lg:grid-cols-2">
          {filtered.map((t) => <div key={`${t.moduleKey}:${t.id}`} className="min-w-0"><TaskCard t={t} goalName={goalName(t.goalId)} busy={busy} busyAction={busyAction} pendingAction={pending[t.id]?.action} onOpen={openTask} onStop={doStop} onRestart={doRestart} onPause={doPause} onResume={doResume} canControl={canControl(t)} selected={selected.has(t.id)} onToggleSelect={toggleSel} problem={taskProblems(t)} fatigue={fatigueOf(t)} /></div>)}
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
function CardControls({ t, busy, busyAction, pendingAction, onStop, onRestart, onPause, onResume, canControl = true }: {
  t: ModuleTask; busy: string | null; busyAction: 'start' | 'pause' | 'stop' | null
  pendingAction?: 'pause' | 'stop'
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; canControl?: boolean
}) {
  // Нет доступа к модулю — управления нет вовсе. Неактивная кнопка тут читалась бы
  // как «сейчас нельзя», хотя нельзя вообще.
  if (!canControl) return null
  // MR-130+: пока идёт действие по ЭТОЙ задаче — все три кнопки заблокированы, а на
  // нажатой крутится лоадер (нельзя слать миллиард пауз/стопов, видно «в процессе»).
  // pendingAction держит блок ДО фактической остановки воркера, а не только на время
  // запроса — иначе «Стоп» разблокировался бы через ~100мс, пока задача ещё крутится.
  const disabled = busy === t.id || !!pendingAction
  const canStart = ['paused', 'stopped', 'done', 'error'].includes(t.status)
  const canPause = t.status === 'running'
  const canStop = t.status === 'running' || t.status === 'queued' || t.status === 'paused'
  // paused/stopped — продолжаем с места (resume); done/error — перезапуск с нуля (restart).
  const canResume = t.status === 'paused' || t.status === 'stopped'
  const startTitle = canResume ? 'Возобновить с места' : 'Запустить'
  const cls = (active: boolean, tone: string) => cn('btn-icon h-8 w-8', active && !disabled ? tone : 'text-white/20')
  const spin = (a: 'start' | 'pause' | 'stop') => (pendingAction ? pendingAction === a : busy === t.id && busyAction === a)
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button onClick={() => (canResume ? onResume(t) : onRestart(t))} disabled={disabled || !canStart} className={cls(canStart, 'text-spark-400 hover:bg-spark-500/12')} aria-label={startTitle} title={spin('start') ? 'Запускается…' : startTitle}>{spin('start') ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}</button>
      <button onClick={() => onPause(t)} disabled={disabled || !canPause} className={cls(canPause, 'text-amber-300 hover:bg-amber-500/12')} aria-label="Пауза" title={spin('pause') ? 'В процессе паузы…' : 'Пауза'}>{spin('pause') ? <Loader2 size={13} className="animate-spin" /> : <Pause size={13} />}</button>
      <button onClick={() => onStop(t)} disabled={disabled || !canStop} className={cls(canStop, 'text-rose-300 hover:bg-rose-500/12')} aria-label="Стоп" title={spin('stop') ? 'В процессе остановки…' : 'Стоп'}>{spin('stop') ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}</button>
    </div>
  )
}

function TaskCard({ t, goalName, busy, busyAction, pendingAction, onOpen, onStop, onRestart, onPause, onResume, canControl = true, compact, selected, onToggleSelect, problem, fatigue }: {
  t: ModuleTask; goalName: string | null; busy: string | null; busyAction: 'start' | 'pause' | 'stop' | null
  pendingAction?: 'pause' | 'stop'
  onOpen: (t: ModuleTask) => void
  onStop: (t: ModuleTask) => void; onRestart: (t: ModuleTask) => void
  onPause: (t: ModuleTask) => void; onResume: (t: ModuleTask) => void; canControl?: boolean; compact?: boolean
  selected?: boolean; onToggleSelect?: (id: string) => void
  problem?: TaskProblem // MR-146: сколько аккаунтов задачи «отвалилось» и почему
  fatigue?: FatigueHint | null // профиль усталости её аккаунтов — для честного ETA
}) {
  // Оптимистичный статус: пока воркер реально не встал, показываем «Останавливается…» —
  // честнее, чем застывшее «Выполняется», и сразу видно, что кнопка сработала.
  const st = pendingAction
    ? { label: pendingAction === 'stop' ? 'Останавливается…' : 'Ставим на паузу…', tone: 'amber' as const }
    : (STATUS[t.status] || { label: t.status, tone: 'muted' as const })
  const p = pct(t)
  const running = isActive(t) || !!pendingAction
  const ringColor = pendingAction ? STATUS_COLOR.stopped : (STATUS_COLOR[t.status] || '#94a3b8')
  return (
    <Card className={cn('flex h-full flex-col', compact ? 'bg-elevated/40 p-2.5' : 'p-3')}>
      <div className="flex items-center gap-3">
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
          {/* MR-109: ETA — прогноз оставшегося времени. У работающей задачи (зелёным) —
              время до конца; у остановленной/на паузе (приглушённо, «при запуске») — сколько
              займёт, если её запустить/возобновить. Не показываем у готовых и с ошибкой. */}
          {(() => { const e = taskEtaMs(t, fatigue); if (e == null) return null; const run = t.status === 'running'; return (
            <Tip className={cn('inline-flex items-center gap-1 tabular-nums', run ? 'text-emerald-300/80' : 'text-white/35')} text={run ? 'Прогноз времени до завершения — по текущему темпу' : 'Сколько ещё займёт задача, если её запустить/возобновить'}><Clock size={11} /> ≈ {fmtDur(e / 1000)}{run ? '' : ' при запуске'}</Tip>
          ) })()}
        </div>
      </div>
      </button>
      <CardControls t={t} busy={busy} busyAction={busyAction} pendingAction={pendingAction} onStop={onStop} onRestart={onRestart} onPause={onPause} onResume={onResume} canControl={canControl} />
      </div>
      {/* MR-145 (созвон 12.08): задача с ошибкой — карточка двойной высоты: вторая половина
          отдана под описание ошибки со скроллом, чтобы разбирать провал прямо здесь, а не
          открывать каждую задачу и лазить в логи. */}
      {t.status === 'error' && (
        <div className="mt-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[.07] p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-rose-300"><AlertTriangle size={12} /> Ошибка задачи</div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-rose-200/90">{t.fatalError || t.lastError || 'Задача завершилась с ошибкой — подробности в логах задачи.'}</div>
        </div>
      )}
      {/* MR-146: warning-система — если аккаунты задачи отвалились, показываем второй блок
          «N из M с проблемой». Градация: боевые модули (нейродиалог/чаттинг/…) — ошибка (красный),
          остальные (прогрев/парсинг) — предупреждение (жёлтый). На задаче «Ошибка» не дублируем. */}
      {t.status !== 'error' && problem && problem.bad > 0 && (() => {
        // Цвет — по ПОСЛЕДСТВИЮ, а не по типу модуля. Раньше красным красились боевые
        // модули, жёлтым остальные, и одна и та же беда («прокси не отвечает») выглядела
        // по-разному в соседних карточках. Теперь: не поедет никто — красный, часть
        // исполнителей осталась — жёлтый.
        const hard = problem.bad >= problem.total
        // Заголовок: при одном аккаунте «1 из 1 с проблемой» звучит как отчёт бухгалтера —
        // пишем просто «аккаунт недоступен». Счётчик нужен, только когда есть из чего выбирать.
        const head = problem.total === 1
          ? 'Аккаунт недоступен'
          : hard
            ? `Все аккаунты недоступны · ${problem.total}`
            : `Часть аккаунтов недоступна · ${problem.bad} из ${problem.total}`
        // Причины группируем: «нет прокси» и «нужна переавторизация» чинятся по-разному,
        // и оператор должен видеть, ЧТО именно чинить, а не список всех возможных бед.
        const byReason = new Map<string, string[]>()
        for (const it of problem.items || []) {
          const list = byReason.get(it.reason) || []
          list.push(it.name)
          byReason.set(it.reason, list)
        }
        return (
          <div className={cn('mt-2.5 rounded-xl border p-2.5', hard ? 'border-rose-500/25 bg-rose-500/[.07]' : 'border-amber-500/25 bg-amber-500/[.07]')}>
            <div className={cn('flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide', hard ? 'text-rose-300' : 'text-amber-300')}>
              <AlertTriangle size={12} /> {head}
            </div>
            <div className={cn('mt-0.5 space-y-0.5 text-[11px] leading-relaxed', hard ? 'text-rose-200/80' : 'text-amber-200/80')}>
              {[...byReason.entries()].map(([reason, names]) => (
                <div key={reason} className="truncate">
                  <b className="font-semibold">{reason}</b>
                  {': '}
                  {names.slice(0, 3).join(', ')}
                  {names.length > 3 ? ` и ещё ${names.length - 3}` : ''}
                </div>
              ))}
              <div className="opacity-70">Чинится в менеджере аккаунтов.</div>
            </div>
          </div>
        )
      })()}
    </Card>
  )
}


/**
 * Аккаунты задачи. Рядом с именем — короткая пометка проблемы (нет прокси, прокси не
 * отвечает, нужна переавторизация): задача сыпала ошибками по аккаунту, а по списку было
 * не понять, по какому именно и почему. Разворачивать полную карточку здесь не нужно —
 * за деталями идут в менеджер аккаунтов (правка заказчика 12.08).
 */
function TaskAccounts({ accountIds, accounts }: { accountIds: string[]; accounts: TgAccount[] }) {
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  /** Коротко о проблеме — видно прямо в списке. */
  const problemOf = (a?: TgAccount) => {
    if (!a) return ''
    if (!a.proxy || a.proxy === '—') return 'нет прокси'
    if (a.proxyOk === false) return 'прокси не отвечает'
    if (a.status === 'reauth') return 'нужна переавторизация'
    if (a.status === 'invalid') return 'невалиден'
    if (a.status === 'spamblock') return 'спамблок'
    if (a.status === 'quarantine') return 'карантин'
    return ''
  }
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 text-sm font-bold text-fg">Аккаунты в работе <span className="text-white/40">({accountIds.length})</span></div>
      {accountIds.length === 0 ? (
        <div className="py-1 text-xs text-white/40">Аккаунты не заданы</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {accountIds.map((aid) => {
            const a = byId.get(aid)
            const label = a ? (a.name || a.username || a.phone || aid) : aid
            const problem = problemOf(a)
            return (
              <span
                key={aid}
                title={problem ? `Проблема: ${problem}. Чинится в менеджере аккаунтов.` : undefined}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border px-2 py-0.5 text-xs',
                  problem
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : 'border-iris-500/25 bg-iris-500/10 text-iris-200',
                )}
              >
                {problem && <AlertTriangle size={11} className="shrink-0" />}
                {label}
                {problem && <span className="text-[10px] opacity-80">· {problem}</span>}
              </span>
            )
          })}
        </div>
      )}
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
  const [busyAction, setBusyAction] = useState<'start' | 'pause' | 'stop' | null>(null)
  // «В процессе остановки/паузы» до фактической остановки воркера (см. TasksPage).
  const [pendingAct, setPendingAct] = useState<'pause' | 'stop' | null>(null)

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

  // Задача реально встала (или зависла) — снимаем «в процессе», разблокируем кнопки.
  useEffect(() => {
    if (!pendingAct) return
    if (task && actionSettled(task, pendingAct)) { setPendingAct(null); return }
    const to = setTimeout(() => setPendingAct(null), PENDING_TIMEOUT_MS)
    return () => clearTimeout(to)
  }, [task, pendingAct])

  const goalName = (gid?: string | null) => { const g = goals.find((x) => x.id === gid); return g?.name || (gid ? '—' : null) }

  const reload = async () => { try { setTask(await fetchModuleTask(moduleKey, id)) } catch { /* ignore */ } }
  const run = async (fn: () => Promise<unknown>, okTitle: string, action?: 'start' | 'pause' | 'stop') => {
    setBusy(true); setBusyAction(action ?? null)
    try { await fn(); pushToast({ type: 'success', title: okTitle }); await reload() }
    catch (err) { setPendingAct(null); pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(false); setBusyAction(null) }
  }
  // «Стоп»/«Пауза» лишь просят воркера встать — держим кнопки заблокированными и статус
  // «Останавливается…», пока задача реально не встанет (снимаем в эффекте ниже).
  const doStop = () => { setPendingAct('stop'); void run(() => stopModuleTask(moduleKey, id), 'Останавливаю задачу…', 'stop') }
  const doPause = () => { setPendingAct('pause'); void run(() => pauseModuleTask(moduleKey, id), 'Ставлю на паузу…', 'pause') }
  const doResume = () => void run(() => resumeModuleTask(moduleKey, id), 'Задача продолжена', 'start')
  const doRestart = async () => {
    // #4: рестарт боевого модуля = реальные действия в Telegram — подтверждаем.
    if (isCombatModule(moduleKey) && !(await confirmDialog({ title: 'Реальные действия в Telegram', message: combatConfirmText(moduleKey), confirmLabel: 'Запустить', tone: 'danger' }))) return
    // Отказ в диалоге исключения — не ошибка. Рестарт заводит НОВУЮ задачу, старая
    // остаётся «Остановлена» — переходим на новую, иначе кажется, что кнопка не сработала (тест 6.2).
    setBusy(true); setBusyAction('start')
    try {
      const fresh = await launchWithSkip((skip) => restartModuleTask(moduleKey, id, skip))
      if (fresh) { pushToast({ type: 'success', title: 'Создана новая задача', desc: fresh.id }); navigate(`/panel/tasks/${fresh.id}?m=${moduleKey}`) }
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' })
    } finally { setBusy(false); setBusyAction(null) }
  }

  // §9.8: правка задачи — только на паузе (сервер это тоже проверяет и вернёт 409).
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
  // MR-147: карточка задачи = вкладки «Описание»/«Настройки».
  const [detTab, setDetTab] = useState<'desc' | 'settings'>('desc')

  /** Состав исполнителей задачи — правится тем же пикером, что и при создании (12.08). */
  const [edAccounts, setEdAccounts] = useState<Set<string>>(new Set())
  /** Править можно всё, что не бежит прямо сейчас (то же правило, что на сервере). */
  const canEditNow = !!task && task.status !== 'running' && task.status !== 'queued'

  // Форма настроек открыта ВСЕГДА (карандаш убран) — значит заполняем её из задачи, как
  // только та загрузилась, и переливаем заново при смене задачи.
  useEffect(() => {
    const s = task?.settings
    if (!s) return
    setEdTargets((s.channels || s.targets || []).join('\n'))
    const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
    setEdMinActions(str(s.minActions))
    setEdMaxActions(str(s.maxActions))
    setEdMinPerAcc(str(s.minPerAccount))
    setEdMaxPerAcc(str(s.maxPerAccount))
    setEdAccounts(new Set(s.accountIds || []))
    // Перезаливаем только при СМЕНЕ задачи: иначе живой опрос (раз в 3с) затирал бы
    // то, что человек прямо сейчас печатает.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id])

  const saveEdit = async () => {
    const targets = edTargets.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    // Пустое поле НЕ отправляем — иначе «не задано» превратится в явный 0.
    const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Number(v) || 0))
    await run(
      () => updateModuleTaskSettings(moduleKey, id, {
        accountIds: [...edAccounts],
        targets, channels: targets,
        minActions: num(edMinActions), maxActions: num(edMaxActions),
        minPerAccount: num(edMinPerAcc), maxPerAccount: num(edMaxPerAcc),
      }),
      'Настройки задачи обновлены',
    )
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
  const st = pendingAct
    ? { label: pendingAct === 'stop' ? 'Останавливается…' : 'Ставим на паузу…', tone: 'amber' as const }
    : (STATUS[t.status] || { label: t.status, tone: 'muted' as const })
  // Заблокированы, пока задача реально не встала — не только на время запроса.
  const ctlBusy = busy || !!pendingAct
  const p = pct(t)
  const s = t.settings || {}
  const logs = (t.logs || []).slice(0, 300)
  /*
   * `||` здесь не работал: пустой массив в JS — ИСТИНА, поэтому `t.results = []`
   * перекрывал `commentHistory`, и у нейрокомментинга результаты всегда выходили
   * пустыми. Комментарий было видно только в логе и только обрезанным — отсюда
   * «не вижу комменты» (вопрос владельца 22.08). Берём первый НЕПУСТОЙ источник.
   */
  const results = ((t.results?.length ? t.results : t.commentHistory) || []) as Record<string, unknown>[]
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
          <Ring value={p} color={pendingAct ? STATUS_COLOR.stopped : (STATUS_COLOR[t.status] || '#94a3b8')} size={66} stroke={6} pulse={isActive(t) || !!pendingAct} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-sm font-semibold text-fg">{moduleTitle(t.moduleKey)}</span>
            </div>
            {/* MR-147: «Модуль» и «Потрачено» перенесены сюда, к прогрессу. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-white/60">
              <span>{t.progress?.done ?? t.progress?.actionsDone ?? 0} / {t.progress?.total ?? 0} действий</span>
              {/* MR-109: ETA — у работающей задачи время до конца (зелёным), у остановленной/
                  на паузе прогноз «при запуске» (приглушённо). */}
              {(() => { const e = taskEtaMs(t); if (e == null) return null; const run = t.status === 'running'; return (
                <Tip className={cn('inline-flex items-center gap-1 tabular-nums', run ? 'text-emerald-300/80' : 'text-white/40')} text={run ? 'Прогноз времени до завершения — по текущему темпу' : 'Сколько ещё займёт задача, если её запустить/возобновить'}><Clock size={13} /> ≈ {fmtDur(e / 1000)}{run ? '' : ' при запуске'}</Tip>
              ) })()}
              {/* Фактическое ожидание: сумма всех пауз задачи. Рядом с прогнозом, но тише —
                  прогноз отвечает «сколько ещё», а это «сколько уже простояли». Без этой
                  цифры «5 действий за час» выглядело как поломка (правка 20.08). */}
              {!!t.progress?.waitMs && (
                <span className="inline-flex items-center gap-1 tabular-nums text-white/35" title="Фактическое время в паузах: задержки между действиями, чтение и набор, ожидание отдыха аккаунтов">
                  <Hourglass size={12} /> в паузах {fmtDur(t.progress.waitMs / 1000)}
                </span>
              )}
              {/* Голая цифра «⚡ 0.00» ни о чём не говорила — подписываем, что это расход
                  ИМЕННО этой задачи (из общего баланса он не читается). */}
              <Tip className="items-baseline gap-1 tabular-nums text-amber-300/80" text={t.tokenCoins ? `${fmtCoins(t.spentCoins || 0)} ⚡ за действия + ${fmtCoins(t.tokenCoins)} ⚡ за ИИ` : undefined}>
                <span className="text-[11px] text-white/40">потрачено</span>
                ⚡ {fmtCoins((t.spentCoins || 0) + (t.tokenCoins || 0))}{t.tokens ? ` · ${t.tokens.toLocaleString('ru-RU')} токенов` : ''}
              </Tip>
            </div>
          </div>
          {/* Управление — только тем, у кого есть доступ к модулю задачи. */}
          <div className="flex shrink-0 gap-1">
            {canControl && (isActive(t) || !!pendingAct) && <button onClick={doPause} disabled={ctlBusy || !isActive(t)} className="btn-icon h-9 w-9" title={pendingAct === 'pause' || busyAction === 'pause' ? 'В процессе паузы…' : 'Пауза'}>{pendingAct === 'pause' || busyAction === 'pause' ? <Loader2 size={15} className="animate-spin" /> : <Pause size={15} />}</button>}
            {canControl && (t.status === 'paused' || t.status === 'stopped') && !pendingAct && <button onClick={doResume} disabled={ctlBusy} className="btn-icon h-9 w-9 text-spark-400" title={busyAction === 'start' ? 'Запускается…' : t.status === 'stopped' ? 'Возобновить с места остановки' : 'Продолжить'}>{busyAction === 'start' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}</button>}
            {canControl && (isActive(t) || !!pendingAct) && <button onClick={doStop} disabled={ctlBusy} className="btn-icon h-9 w-9 text-rose-300" title={pendingAct === 'stop' || busyAction === 'stop' ? 'В процессе остановки…' : 'Стоп'}>{pendingAct === 'stop' || busyAction === 'stop' ? <Loader2 size={15} className="animate-spin" /> : <Square size={15} />}</button>}
            {/* §9.8: правка только на паузе — вынесена во вкладку «Настройки». */}
            {canControl && <button onClick={doRestart} disabled={ctlBusy} className="btn-icon h-9 w-9" title="Перезапуск"><RotateCw size={16} /></button>}
          </div>
        </div>

        {/* MR-147: мелкая серая строка вместо плашек Кампания/Цель/Инициатор/Создана/Обновлена. */}
        <div className="text-xs text-muted">
          Создана {new Date(t.createdAt).toLocaleString('ru-RU')} · обновлена {new Date(t.updatedAt).toLocaleString('ru-RU')}
          {t.campaignId ? ` · кампания: ${campaignsList.find((c) => c.id === t.campaignId)?.name || t.campaignId}` : ''}
          {t.goalId ? ` · цель: ${goalName(t.goalId)}` : ''}
          {t.initiator ? ` · ${t.initiator}` : ''}
        </div>

        {/* MR-147: вкладки «Описание» / «Настройки». */}
        <div className="flex gap-1 rounded-xl border border-line bg-elevated/40 p-1">
          {([['desc', 'Описание'], ['settings', 'Настройки']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setDetTab(key)}
              className={`h-9 flex-1 rounded-lg text-sm font-semibold transition ${detTab === key ? 'bg-spark-500/15 text-spark-200' : 'text-white/55 hover:text-white/80'}`}
            >{label}</button>
          ))}
        </div>

        {detTab === 'settings' && (
          // Настройки задачи выглядят как её СОЗДАНИЕ (звонок 12.08): тот же блок выбора
          // аккаунтов, что в модуле, и поля сразу открыты — без карандаша и без плашек
          // «Аккаунтов 1 / Каналов 1 / Кампания», которые ничего не давали править.
          <div className="space-y-3">
            {!canEditNow && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Задача выполняется — часть аккаунтов уже отработала по текущим настройкам.
                Нажмите «Пауза» или «Стоп», и настройки станут доступны.
              </div>
            )}

            {/* Аккаунты: переиспользуем готовый пикер из модулей — поиск, фильтры, статусы,
                видно и выбранные, и доступные. Плюс-минус прямо здесь. */}
            <div className={cn('rounded-2xl border border-line bg-elevated/40 p-3', !canEditNow && 'pointer-events-none opacity-60')}>
              <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg">
                Аккаунты задачи <span className="text-white/40">({edAccounts.size})</span>
              </div>
              <AccountPicker selected={edAccounts} onChange={setEdAccounts} selectedTitle="В задаче" />
            </div>

            <div className={cn('rounded-2xl border border-line bg-elevated/40 p-3', !canEditNow && 'pointer-events-none opacity-60')}>
              <div className="mb-2 text-sm font-bold text-fg">Параметры модуля</div>
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
              {/* Что применится сразу, а что — при следующем запуске. Иначе непонятно,
                  зачем править остановленную задачу. */}
              <div className="mt-2 text-[11px] text-muted">
                {t.status === 'paused'
                  ? 'Применится, как только продолжите задачу.'
                  : 'Применится при следующем запуске этой задачи.'}
              </div>
            </div>

            {canControl && (
              <div className="flex gap-2">
                <button onClick={() => void saveEdit()} disabled={busy || !canEditNow} className="btn-primary h-9 disabled:opacity-40">Сохранить</button>
              </div>
            )}
          </div>
        )}

        {detTab === 'desc' && (
          <div className="space-y-4">
        <TaskAccounts accountIds={s.accountIds || []} accounts={accounts} />
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
                /*
                 * Правка 22.08 (вопрос владельца: «не вижу комменты в нейрокомментинге»).
                 * Таблица была одна на всё — с заголовками парсера: «Имя · Юзернейм ·
                 * Откуда · Тип». Комментарий при этом попадал в колонку «Откуда», канал
                 * и номер поста не показывались вовсе, и найти на экране то, что аккаунт
                 * реально написал, было нельзя.
                 *
                 * Отправленное СООБЩЕНИЕ (комментарий, ответ, ЛС) — это другой результат,
                 * чем строка парсера, и колонки у него свои.
                 */
                results.some((r) => r.comment || r.text) ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-muted">
                        <th className="py-1.5 w-40">Аккаунт</th>
                        <th className="w-44">Куда</th>
                        <th>Что написал</th>
                        <th className="w-24 text-right">Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.slice((resPage - 1) * RES_PER_PAGE, resPage * RES_PER_PAGE).map((r, i) => {
                        const канал = String(r.channel ?? r.target ?? r.peer ?? '')
                        const пост = r.postId ? `· пост #${String(r.postId)}` : ''
                        const текст = String(r.comment ?? r.text ?? '')
                        return (
                          <tr key={i} className="border-b border-line/50 align-top">
                            <td className="py-1.5 font-medium text-fg">{String(r.accountName ?? r.name ?? '—')}</td>
                            <td className="text-xs text-muted">
                              {канал ? <span className="font-mono">{канал.startsWith('@') ? канал : `@${канал}`}</span> : <span className="text-white/25">—</span>}
                              {пост ? <span className="ml-1 text-white/35">{пост}</span> : null}
                            </td>
                            {/* Сам текст — главное на этом экране, поэтому он не обрезается в одну строку. */}
                            <td className="py-1.5 pr-3 text-xs leading-relaxed text-white/75">{текст || <span className="text-white/25">—</span>}</td>
                            <td className="text-right"><span className="text-xs text-white/40">{String(r.status ?? '')}</span></td>
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
                )
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
        )}
      </div>
    </div>
  )
}
