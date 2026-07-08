import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Play, Save, Square, Sparkles, Plus, Trash2, Clock, Globe, Hash, Eye, Megaphone, Mail,
  Settings2, Bolt, MessageSquareText, AlertTriangle, Check, Bookmark, ChevronDown,
  Timer, Users, ListChecks, X, MessageCircle, LayoutGrid, List, Loader2,
} from 'lucide-react'
import { MODULES } from '@/shared/config/modules'
import { useApp, activeAccounts } from '@/mocks/store'
import {
  ToggleGroup, Segmented, EmptyState, Switch, Badge,
} from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { cn } from '@/shared/lib/utils'
import type { LogEntry } from '@/shared/types'
import {
  startNeuroCommentingTask,
  fetchNeuroTask,
  fetchNeuroTasks,
  stopNeuroTask,
  saveNeuroPreset,
  fetchNeuroPresets,
  type NeuroCommentingSettings,
  type NeuroTask,
  type CommentHistoryItem,
} from '@/api/neuroCommentingApi'
import { SectionCard, NumberField, ToggleRow, LaunchStat, DelayFields, SingleDelayField } from './moduleUi'
import { ProtectionBlock, PromptCards, loadPromptBodies, AiGenerationNotice } from '@/features/modules/shared'
import { persistActiveTaskId, readActiveTaskId, pickTaskIdToRestore, mapTaskStatus } from '@/features/modules/shared/activeTaskStorage'

const cfg = MODULES['neuro-commenting']

const DEFAULT_DELAYS = {
  comment: [30, 120] as [number, number],
  join: [84, 156] as [number, number],
  floodWait: 120,
  floodQuarantine: 3,
}

export function NeuroCommentingModule() {
  const addTask = useApp((s) => s.addTask)
  const updateTask = useApp((s) => s.updateTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)
  const loadAccounts = useApp((s) => s.loadAccounts)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const accounts = activeAccounts(useApp((s) => s.data))

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [toggles, setToggles] = useState<Record<number, number>>({})
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [probability, setProbability] = useState(30)
  const [perAccountProb, setPerAccountProb] = useState(false)
  const [maxComments, setMaxComments] = useState(100)
  const [maxPerAcc, setMaxPerAcc] = useState(10)
  const [minWords, setMinWords] = useState(0)
  const [durationMinutes, setDurationMinutes] = useState(60)
  const [srcTab, setSrcTab] = useState(0)
  const [channelsInput, setChannelsInput] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [keywords, setKeywords] = useState('')
  const [aiPrompt, setAiPrompt] = useState(true)
  const [aiMode, setAiMode] = useState(0)
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() => loadPromptBodies('neuro-commenting', cfg.messagePrompts ?? []))
  const [sendAsChannel, setSendAsChannel] = useState(false)
  const [deletionTrack, setDeletionTrack] = useState(false)
  const [langMode, setLangMode] = useState(0)
  const [alwaysOn, setAlwaysOn] = useState(true)
  const [autoResp, setAutoResp] = useState(0)
  const [delayPreset, setDelayPreset] = useState(1)
  const [delays, setDelays] = useState(DEFAULT_DELAYS)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])
  const [viewTab, setViewTab] = useState(0)
  const [historyGrid, setHistoryGrid] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(true)

  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<NeuroTask | null>(null)
  const [starting, setStarting] = useState(false)

  const running = task?.status === 'running' || task?.status === 'queued'
  const logs: LogEntry[] = task?.logs ?? []
  const commentHistory: CommentHistoryItem[] = task?.commentHistory ?? []

  const g = (i: number) => toggles[i] ?? 0
  const setTg = (i: number, v: number) => setToggles((t) => ({ ...t, [i]: v }))
  const showProb = g(0) === 0 || g(0) === 1

  const buildSettings = useCallback((): NeuroCommentingSettings => ({
    accountIds: [...selected],
    channels: targets,
    commentMode: g(0),
    workMode: g(1),
    postFilter: g(2),
    probability,
    maxComments,
    maxPerAccount: maxPerAcc,
    minWords,
    durationMinutes: g(1) === 1 ? durationMinutes : undefined,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    aiMode,
    keywords: keywords.split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean),
    delayPreset,
    delays,
  }), [selected, targets, toggles, probability, maxComments, maxPerAcc, minWords, durationMinutes, aiProtect, protLevel, activePrompt, promptBodies, aiMode, keywords, delayPreset, delays])

  useEffect(() => {
    void fetchNeuroPresets().then((p) => setPresets(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const tasks = await fetchNeuroTasks()
        const id = pickTaskIdToRestore(tasks, readActiveTaskId('neuro-commenting'))
        if (!id || cancelled) return
        const t = await fetchNeuroTask(id)
        if (cancelled) return
        setTaskId(t.id)
        setTask(t)
        persistActiveTaskId('neuro-commenting', t.id)
        const exists = useApp.getState().data.tasks.some((x) => x.id === t.id)
        const patch = {
          status: mapTaskStatus(t.status),
          progress: t.progress.total ? Math.round((t.progress.commentsSent / t.progress.total) * 100) : 0,
          logCount: t.logs.length,
        }
        if (exists) updateTask(t.id, patch)
        else addTask({ id: t.id, module: cfg.key, title: `${cfg.title}`, accountsCount: t.settings.accountIds.length, ...patch })
      } catch { /* ignore */ }
    }
    void restore()
    return () => { cancelled = true }
  }, [addTask, updateTask])

  useEffect(() => {
    if (!taskId || !running) return
    const poll = async () => {
      try {
        const t = await fetchNeuroTask(taskId)
        setTask(t)
        updateTask(taskId, {
          status: t.status === 'running' ? 'running' : t.status === 'done' ? 'done' : t.status === 'error' ? 'error' : 'paused',
          progress: t.progress.total ? Math.round((t.progress.commentsSent / t.progress.total) * 100) : 0,
          logCount: t.logs.length,
        })
        if (t.status !== 'running' && t.status !== 'queued') {
          void loadAccounts()
      void loadAccountBusy()
        }
      } catch {
        /* ignore poll errors */
      }
    }
    poll()
    const id = setInterval(poll, 2500)
    return () => clearInterval(id)
  }, [taskId, running, updateTask, loadAccounts])

  const addTargets = () => {
    const parsed = channelsInput.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split('/')[0]).filter(Boolean)
    if (!parsed.length) return pushToast({ type: 'error', title: 'Нет каналов', desc: 'Введите @username или ссылку t.me/...' })
    setTargets((t) => [...new Set([...parsed, ...t])])
    setChannelsInput('')
    pushToast({ type: 'success', title: 'Добавлено', desc: `${parsed.length} канал(ов)` })
  }

  const busySelectedCount = useMemo(
    () => [...selected].filter((id) => accounts.some((a) => a.id === id && a.busyIn)).length,
    [selected, accounts],
  )
  const canStart = selected.size > 0 && busySelectedCount === 0 && targets.length > 0

  const start = async () => {
    if (!guardNet('запуск нейрокомментинга')) return
    if (!selected.size) return pushToast({ type: 'error', title: 'Аккаунты не выбраны' })
    if (busySelectedCount) return pushToast({ type: 'error', title: 'Аккаунты заняты', desc: `${busySelectedCount} профилей уже работают в другом модуле` })
    if (!targets.length) return pushToast({ type: 'error', title: 'Каналы не указаны', desc: 'Добавьте хотя бы один канал.' })
    setStarting(true)
    try {
      const settings = buildSettings()
      const t = await startNeuroCommentingTask(settings)
      setTaskId(t.id)
      setTask(t)
      persistActiveTaskId('neuro-commenting', t.id)
      addTask({
        id: t.id,
        module: cfg.key,
        title: `${cfg.title} · ${selected.size} акк.`,
        status: 'running',
        progress: 0,
        accountsCount: selected.size,
        logCount: 0,
      })
      pushToast({ type: 'success', title: 'Задача запущена', desc: `ID: ${t.id}` })
      void loadAccountBusy()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось запустить', desc: e instanceof Error ? e.message : 'Ошибка' })
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    if (!taskId) return
    try {
      const t = await stopNeuroTask(taskId)
      setTask(t)
      updateTask(taskId, { status: 'paused', progress: t.progress.total ? Math.round((t.progress.commentsSent / t.progress.total) * 100) : 0 })
      pushToast({ type: 'info', title: 'Остановка…', desc: 'Задача завершит текущий шаг и остановится.' })
      void loadAccounts()
      void loadAccountBusy()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка остановки', desc: e instanceof Error ? e.message : '' })
    }
  }

  const savePreset = async () => {
    const name = window.prompt('Название пресета настроек')
    if (!name?.trim()) return
    try {
      await saveNeuroPreset(name.trim(), buildSettings())
      const p = await fetchNeuroPresets()
      setPresets(p.map((x) => ({ id: x.id, name: x.name })))
      pushToast({ type: 'success', title: 'Пресет сохранён', desc: name })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  const progressPct = useMemo(() => {
    if (!task?.progress.total) return 0
    return Math.min(100, Math.round((task.progress.commentsSent / task.progress.total) * 100))
  }, [task])

  const intervalLabel = `${delays.comment[0]}–${delays.comment[1]}с`

  return (
    <div className="space-y-4">
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      <SectionCard icon={<Settings2 size={18} />} title={cfg.settingsTitle ?? 'Настройки'} badge={`${targets.length} каналов`}>
        <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-fg"><Bolt size={15} className="text-spark-400" /> {cfg.toggleGroups![0].label}</div>
            <ToggleGroup label="" options={cfg.toggleGroups![0].options} value={g(0)} onChange={(v) => setTg(0, v)} />
            {g(0) === 1 && (
              <div>
                <label className="label">Ключевые слова (через запятую или с новой строки)</label>
                <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className="input resize-none text-sm" placeholder="crypto, bitcoin, airdrop" />
              </div>
            )}
            {showProb && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-muted">{cfg.probabilitySlider!.label}</span>
                  <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{probability}%</span>
                </div>
                <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
                <div className="mt-2"><Switch checked={perAccountProb} onChange={setPerAccountProb} label="Задавать вероятность на аккаунт" /></div>
              </div>
            )}
            {cfg.toggleGroups![2] && (
              <div className="border-t border-line pt-3">
                <div className="mb-2 text-sm font-bold text-fg">{cfg.toggleGroups![2].label}</div>
                <ToggleGroup label="" options={cfg.toggleGroups![2].options} value={g(2)} onChange={(v) => setTg(2, v)} />
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-fg"><Clock size={15} className="text-spark-400" /> {cfg.toggleGroups![1].label}</div>
            <ToggleGroup label="" options={cfg.toggleGroups![1].options} value={g(1)} onChange={(v) => setTg(1, v)} />
            {g(1) === 1 ? (
              <NumberField label="Длительность (мин)" value={durationMinutes} onChange={setDurationMinutes} suffix={`${durationMinutes}m`} />
            ) : (
              <div className="space-y-3">
                <NumberField label={cfg.workModeFields!.maxLabel} value={maxComments} onChange={setMaxComments} />
                <NumberField label="Макс. комментариев на аккаунт" value={maxPerAcc} onChange={setMaxPerAcc} suffix={maxPerAcc === 0 ? '∞' : undefined} />
                <NumberField label="Мин. слов в посте" value={minWords} onChange={setMinWords} />
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={<Hash size={18} />} title={cfg.sourceTabs?.label ?? 'Каналы'} badge={String(targets.length)}>
        {cfg.sourceTabs && cfg.sourceTabs.tabs.length > 1 && (
          <Segmented className="mb-3" size="sm" options={cfg.sourceTabs.tabs} value={srcTab} onChange={setSrcTab} />
        )}
        {srcTab === 0 ? (
          <>
            <div className="flex gap-2">
              <textarea value={channelsInput} onChange={(e) => setChannelsInput(e.target.value)} rows={3} className="input resize-none font-mono text-sm" placeholder={cfg.sourceTabs?.placeholder} />
              <button type="button" onClick={addTargets} className="btn-ghost h-auto shrink-0 flex-col px-4"><Plus size={16} /> Добавить</button>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><ListChecks size={13} /> Строк: {channelsInput.split('\n').filter((l) => l.trim()).length}</div>
          </>
        ) : srcTab === 1 ? (
          <EmptyState icon={<Clock size={22} />} title="Прошлые задачи" desc="Выберите каналы из завершённых задач (скоро)." />
        ) : (
          <EmptyState icon={<Bookmark size={22} />} title="Папка каналов" desc="Импорт папки Telegram (скоро)." />
        )}
        {targets.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-bold text-fg">{targets.length} каналов</span>
              <button type="button" onClick={() => setTargets([])} className="flex items-center gap-1 text-xs font-semibold text-rose-300 hover:underline"><Trash2 size={13} /> Очистить</button>
            </div>
            <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
              {targets.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium text-fg">
                  @{t}
                  <button type="button" onClick={() => setTargets((arr) => arr.filter((x) => x !== t))} className="text-faint hover:text-rose-300"><X size={12} /></button>
                </span>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard icon={<Sparkles size={18} />} title="Настройки сообщений"
        right={<label className="flex items-center gap-2 text-sm text-muted">AI-промпт <Switch checked={aiPrompt} onChange={setAiPrompt} /></label>}>
        {aiPrompt && (
          <>
            <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
              <span className="text-sm font-semibold text-fg">Режим генерации</span>
              <Segmented size="sm" options={['Системные', 'Авто', 'Ручной']} value={aiMode} onChange={setAiMode} />
            </div>
            {aiMode !== 2 && cfg.messagePrompts && (
              <div className="mb-4 space-y-3">
                <AiGenerationNotice />
                <PromptCards
                  moduleKey="neuro-commenting"
                  labels={cfg.messagePrompts}
                  activeIndex={activePrompt}
                  onActiveChange={setActivePrompt}
                  onBodiesChange={setPromptBodies}
                />
              </div>
            )}
            {aiMode === 2 && (
              <p className="mb-4 text-sm text-muted">Ручной режим: комментарии из шаблонов без LLM (или задайте OPENAI_API_KEY в .env).</p>
            )}
          </>
        )}
        {cfg.channelToggles && (
          <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <ToggleRow icon={<Megaphone size={16} />} label={cfg.channelToggles[0]} checked={sendAsChannel} onChange={setSendAsChannel} />
            <ToggleRow icon={<Eye size={16} />} label={cfg.channelToggles[1]} checked={deletionTrack} onChange={setDeletionTrack} />
          </div>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {cfg.languageDetection && (
            <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-fg"><Globe size={16} className="text-spark-400" /> Язык</span>
              <Segmented size="sm" options={['Авто', 'Ручной']} value={langMode} onChange={setLangMode} />
            </div>
          )}
          {cfg.activeHours && (
            <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-fg"><Clock size={16} className="text-spark-400" /> Часы активности</span>
              <Switch checked={alwaysOn} onChange={setAlwaysOn} label="Всегда" />
            </div>
          )}
        </div>
      </SectionCard>

      {cfg.autoResponder && (
        <SectionCard icon={<Mail size={18} />} title="Автоответчик">
          <Segmented options={cfg.autoResponder} value={autoResp} onChange={setAutoResp} />
        </SectionCard>
      )}

      <SectionCard icon={<Timer size={18} />} title="Задержки и лимиты"
        right={cfg.delayPresets && <Segmented size="sm" options={cfg.delayPresets!} value={delayPreset} onChange={setDelayPreset} />}>
        <div className="space-y-3">
          <DelayFields label="Задержка комментария" from={delays.comment[0]} to={delays.comment[1]} onFrom={(n) => setDelays((d) => ({ ...d, comment: [n, d.comment[1]] }))} onTo={(n) => setDelays((d) => ({ ...d, comment: [d.comment[0], n] }))} unit="с" />
          <DelayFields label="Задержка вступления в канал" from={delays.join[0]} to={delays.join[1]} onFrom={(n) => setDelays((d) => ({ ...d, join: [n, d.join[1]] }))} onTo={(n) => setDelays((d) => ({ ...d, join: [d.join[0], n] }))} unit="с" />
          <SingleDelayField label="FloodWait задержка (сек)" value={delays.floodWait} onChange={(n) => setDelays((d) => ({ ...d, floodWait: n }))} unit="с" />
          <SingleDelayField label="FloodWait до карантина" value={delays.floodQuarantine} onChange={(n) => setDelays((d) => ({ ...d, floodQuarantine: n }))} />
        </div>
      </SectionCard>

      <div className="card p-0">
        <button type="button" onClick={() => setPresetsOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/12 text-iris-400"><Bookmark size={18} /></span>
          <span className="font-display text-base font-bold text-fg">Пресеты настроек</span>
          <Badge tone="muted">{presets.length}</Badge>
          <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', !presetsOpen && '-rotate-90')} />
        </button>
        {presetsOpen && (
          <div className="border-t border-line p-4">
            {presets.length === 0 ? (
              <EmptyState icon={<Bookmark size={22} />} title="Нет пресетов" desc="Сохраните текущие настройки кнопкой «Сохранить»." />
            ) : (
              <ul className="space-y-2">{presets.map((p) => <li key={p.id} className="rounded-xl border border-line bg-elevated px-3 py-2 text-sm font-medium text-fg">{p.name}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск'} badge={running ? 'LIVE' : undefined}>
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунты" value={String(selected.size)} warn={selected.size === 0} />
          <LaunchStat icon={<Hash size={18} />} color="#06b6d4" label="Каналы" value={String(targets.length)} warn={targets.length === 0} />
          <LaunchStat icon={<Clock size={18} />} color="#0ec464" label="Интервал" value={intervalLabel} />
          <LaunchStat icon={<MessageSquareText size={18} />} color="#f59e0b" label="Макс. комм." value={String(maxComments)} />
        </div>

        {(selected.size === 0 || targets.length === 0 || busySelectedCount > 0) && !running && (
          <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
            <AlertTriangle size={18} className="text-rose-400" />
            <div>
              <div className="text-sm font-bold text-rose-300">Проверьте конфигурацию</div>
              <div className="text-xs text-muted">
                {busySelectedCount > 0
                  ? `${busySelectedCount} акк. заняты в другом модуле — параллельный запуск запрещён`
                  : 'Нужны свободные аккаунты и каналы'}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} />
            {running ? 'Выполняется' : task?.status === 'done' ? 'Завершено' : task?.status === 'stopped' ? 'Остановлено' : 'Готов'}
          </div>
          <div className="flex flex-1 justify-center gap-2">
            {running ? (
              <button type="button" onClick={stop} className="btn-danger h-11 min-w-[180px]"><Square size={16} /> Остановить</button>
            ) : (
              <button type="button" onClick={start} disabled={starting || !canStart} className="btn-primary h-11 min-w-[180px]">
                {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} Начать
              </button>
            )}
          </div>
          <button type="button" onClick={savePreset} className="btn-ghost h-11 text-sm"><Save size={15} /> Сохранить</button>
        </div>

        {running && task && (
          <div className="mt-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-spark-300">Прогресс</span>
              <span className="font-mono font-bold text-fg">{task.progress.commentsSent} / {task.progress.total}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-spark-gradient transition-all" style={{ width: `${progressPct}%` }} /></div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Segmented options={['Визуал', 'Логи']} value={viewTab} onChange={setViewTab} size="sm" />
          {viewTab === 0 && (
            <div className="inline-flex rounded-lg border border-line bg-elevated p-0.5">
              <button type="button" onClick={() => setHistoryGrid(false)} className={cn('rounded p-1.5', !historyGrid ? 'bg-surface text-fg' : 'text-muted')}><List size={15} /></button>
              <button type="button" onClick={() => setHistoryGrid(true)} className={cn('rounded p-1.5', historyGrid ? 'bg-surface text-fg' : 'text-muted')}><LayoutGrid size={15} /></button>
            </div>
          )}
        </div>
      </SectionCard>

      {viewTab === 1 ? (
        <LogsPanel logs={logs} emptyText={cfg.logEmpty ?? 'Логов пока нет'} title="Логи выполнения" live={running} />
      ) : (
        <div className="card p-0">
          <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><MessageCircle size={18} /></span>
            <span className="font-display text-base font-bold text-fg">История комментариев</span>
            <Badge tone="spark">{commentHistory.length}</Badge>
            <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', !historyOpen && '-rotate-90')} />
          </button>
          {historyOpen && (
            <div className="border-t border-line p-4">
              {commentHistory.length === 0 ? (
                <EmptyState icon={<MessageSquareText size={22} />} title="Пока пусто" desc="Комментарии появятся здесь после отправки." />
              ) : historyGrid ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {commentHistory.map((h) => (
                    <CommentCard key={h.id} item={h} />
                  ))}
                </div>
              ) : (
                <ul className="space-y-2">{commentHistory.map((h) => (
                  <li key={h.id} className="rounded-xl border border-line bg-elevated/40 p-3">
                    <div className="flex items-center gap-2 text-xs text-muted"><span>@{h.channel}</span><span>·</span><span>{h.accountName}</span></div>
                    <p className="mt-1 text-sm text-fg">{h.comment}</p>
                  </li>
                ))}</ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-elevated/40 p-4">
        <div className="mb-1 text-sm font-bold text-fg">Чёрный список</div>
        <p className="text-xs text-muted">{cfg.blacklistEmpty}</p>
      </div>
    </div>
  )
}

function CommentCard({ item }: { item: CommentHistoryItem }) {
  return (
    <div className="rounded-xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-bold text-spark-300">@{item.channel}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', item.status === 'sent' ? 'bg-spark-500/15 text-spark-300' : 'bg-rose-500/15 text-rose-300')}>{item.status}</span>
      </div>
      <p className="line-clamp-3 text-sm text-fg">{item.comment}</p>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted"><Check size={12} className="text-spark-400" /> {item.accountName}</div>
    </div>
  )
}
