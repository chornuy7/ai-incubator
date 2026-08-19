import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Info, CalendarClock, Pencil, Trash2, Play, X, Users, Radio, MessageSquareText, Target } from 'lucide-react'
import { PageHeader, Card, NumberField } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { MessageComposer } from '@/features/composer/MessageComposer'
import { useSession } from '@/features/auth/session'
import { type ModuleTaskSettings } from '@/api/modulesApi'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule, runAutomationRuleNow,
  type AutomationRule, type AutomationSchedule,
} from '@/api/automationApi'
import { usePlan, planHasModule } from '@/features/billing/plan'
import { ModuleNotPaid } from '@/features/billing/ModuleNotPaid'
// §3.1 (MR-115): автопостинг приведён к общей структуре модулей — те же переиспользуемые
// блоки (SectionCard + нижняя LaunchPanel со степпером), что и в LiveModule/парсерах.
// Публикации сохраняются как правила автоматизации (moduleKey='autoposting') и переживают рестарт.
import { SectionCard, LaunchPanel, LaunchSteps, markCurrentStep, TaskStartedModal, BlacklistEditor, ProtectionTimings } from '@/features/modules/shared'
import type { DelaysShape } from '@/features/modules/shared/TimingSection'
import { LaunchCost, ActionPriceCalc } from '@/features/modules/shared/LaunchCost'
import { useModuleTask } from '@/features/modules/shared/useModuleTask'
import { PresetBar } from '@/features/modules/shared/PresetBar'
import { SavePresetModal } from '@/features/modules/shared/SavePresetModal'

/** Локальная дата-время в формат `datetime-local` (без сдвига в UTC, как делает toISOString). */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Человекочитаемое расписание для карточки запланированного поста. */
function scheduleLabel(s: AutomationSchedule): string {
  if (s.type === 'once') return s.at ? `Один раз · ${new Date(s.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : 'Один раз · время не задано'
  if (s.type === 'daily') return `Каждый день в ${s.time || '12:00'}`
  return `Каждые ${s.intervalMinutes || 60} мин`
}

export function AutopostingPage() {
  // §5.4/MR-157: гейт — в тонкой обёртке (planModules грузится асинхронно; гейт перед
  // остальными хуками ронял React «Rendered fewer hooks»). Тело — в AutopostingInner.
  const planModules = usePlan((st) => st.modules)
  if (planModules === null) return null // набор ещё не загружен — не мигаем витриной покупки
  if (!planHasModule(planModules, 'autoposting')) return <ModuleNotPaid title="Автопостинг" moduleKey="autoposting" />
  return <AutopostingInner />
}

function AutopostingInner() {
  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [channelsText, setChannelsText] = useState('')
  const [text, setText] = useState('')
  const [media, setMedia] = useState<string[]>([])
  const [delayMin, setDelayMin] = useState(60)
  const [delayMax, setDelayMax] = useState(180)
  // §11: сохранение запланированного поста (правило автоматизации) — свой индикатор,
  // немедленная публикация («Сейчас») идёт через общую машину задач (useModuleTask).
  const [savingRule, setSavingRule] = useState(false)

  // §11: пост можно опубликовать сразу или запланировать. Планирование не плодит второй
  // планировщик — это правило автоматизации с moduleKey='autoposting' (§6), поэтому
  // запланированные посты живут в общем списке автоматизаций и переживают рестарт.
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [schedType, setSchedType] = useState<AutomationSchedule['type']>('once')
  const [schedAt, setSchedAt] = useState(() => toLocalInput(Date.now() + 60 * 60_000))
  const [schedTime, setSchedTime] = useState('12:00')
  const [schedInterval, setSchedInterval] = useState(1440)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  // Защита включена всегда (выключатель убран с экрана 19.08), уровень — базовый:
  // темп теперь задаётся пресетом задержек, а не вторым рядом карточек.
  const aiProtect = true
  const protLevel = 1
  const [delayPreset, setDelayPreset] = useState(1)

  const [rules, setRules] = useState<AutomationRule[]>([])
  const [loadingRules, setLoadingRules] = useState(true)
  const [showSpent, setShowSpent] = useState(false)

  // Общая машина задач модуля — как у остальных модулей: немедленная публикация,
  // состояние, шаблоны, поп-ап со ссылкой в Дашборд задач.
  const { running, starting, start, stop, savePreset, deletePreset, editPreset, presets, task, justStarted, dismissJustStarted } = useModuleTask('autoposting')

  // «Отработавшее» = разовое правило, которое уже выключилось после запуска. Оно ничего
  // больше не сделает, но занимало место наравне с живыми (баг 10.5-b).
  const spentRules = useMemo(() => rules.filter((r) => !r.enabled && r.schedule?.type === 'once'), [rules])
  const activeRules = useMemo(() => rules.filter((r) => !spentRules.includes(r)), [rules, spentRules])
  const visibleRules = showSpent ? [...activeRules, ...spentRules] : activeRules

  const channels = useMemo(() => {
    const raw = channelsText.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    return [...new Set(raw)]
  }, [channelsText])

  // §11: публикацию создаёт только админ (единый отправитель).
  const me = useSession((s) => s.user)
  const canWrite = !me || me.isAdmin
  const ready = selected.size > 0 && channels.length > 0 && text.trim().length > 0
  const canStart = canWrite && ready

  const loadRules = async () => {
    setLoadingRules(true)
    try { setRules((await fetchAutomationRules()).filter((r) => r.moduleKey === 'autoposting')) }
    catch { /* список необязателен для публикации — молча оставляем пустым */ }
    finally { setLoadingRules(false) }
  }
  useEffect(() => { void loadRules() }, [])

  const buildSchedule = (): AutomationSchedule => {
    if (schedType === 'once') return { type: 'once', at: new Date(schedAt).getTime() }
    if (schedType === 'daily') return { type: 'daily', time: schedTime }
    return { type: 'interval', intervalMinutes: schedInterval }
  }

  // Автопостинг хранит паузы парой чисел; общий блок ждёт полную структуру.
  const postingDelays: DelaysShape = {
    comment: [delayMin, delayMax],
    action: [delayMin, delayMax],
    join: [delayMin, delayMax],
    floodWait: 120,
    floodQuarantine: 3,
  }

  const settings = (): ModuleTaskSettings => ({
    accountIds: [...selected],
    targets: channels,
    promptText: text.trim(),
    delays: { action: [delayMin, delayMax] as [number, number] },
    // Защита и темп теперь задаются в интерфейсе, а не берутся умолчаниями: воркер
    // читал эти поля и раньше (см. дескриптор), просто задать их было негде.
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    delayPreset,
    ...(media.length ? { mediaUrls: media } : {}),
  })

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setChannelsText('')
    setText('')
    setMedia([])
    setSelected(new Set())
    setMode('now')
  }

  /** Загрузить запланированный пост в форму — редактируем и аккаунты-«боты», и каналы, и текст. */
  const editRule = (r: AutomationRule) => {
    setEditingId(r.id)
    setName(r.name)
    setSelected(new Set(r.accountIds || []))
    setChannelsText((r.settings?.targets || []).join('\n'))
    setText(String(r.settings?.promptText || ''))
    setMedia(Array.isArray(r.settings?.mediaUrls) ? r.settings.mediaUrls : [])
    const d = r.settings?.delays?.action
    if (Array.isArray(d)) { setDelayMin(d[0] ?? 60); setDelayMax(d[1] ?? 180) }
    setMode('schedule')
    setSchedType(r.schedule?.type || 'once')
    if (r.schedule?.type === 'once' && r.schedule.at) setSchedAt(toLocalInput(r.schedule.at))
    if (r.schedule?.type === 'daily') setSchedTime(r.schedule.time || '12:00')
    if (r.schedule?.type === 'interval') setSchedInterval(r.schedule.intervalMinutes || 1440)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const removeRule = async (r: AutomationRule) => {
    const ok = await confirmDialog({
      title: 'Удалить запланированный пост',
      message: `Пост «${r.name}» больше не опубликуется. Уже опубликованные посты останутся в каналах.`,
    })
    if (!ok) return
    try {
      await deleteAutomationRule(r.id)
      if (editingId === r.id) resetForm()
      await loadRules()
      pushToast({ type: 'success', title: 'Запланированный пост удалён' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' })
    }
  }

  const publishRuleNow = async (r: AutomationRule) => {
    try {
      await runAutomationRuleNow(r.id)
      pushToast({ type: 'success', title: 'Публикация запущена', desc: r.name })
      nav('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось опубликовать', desc: e instanceof Error ? e.message : '' })
    }
  }

  // §10: сохранение через модалку (имя + цвет + владелец), как в остальных модулях.
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  const handleSave = () => setPresetModalOpen(true)

  // Восстановить настройки из шаблона (аккаунты не трогаем).
  const applyPreset = (s: ModuleTaskSettings) => {
    if (Array.isArray(s.targets)) setChannelsText(s.targets.join('\n'))
    if (typeof s.promptText === 'string') setText(s.promptText)
    if (Array.isArray(s.mediaUrls)) setMedia(s.mediaUrls)
    if (s.delays?.action) { setDelayMin(s.delays.action[0]); setDelayMax(s.delays.action[1]) }
  }

  async function launch() {
    // «Сейчас» — немедленная задача через общую машину (поп-ап со ссылкой в Дашборд задач).
    if (mode === 'now') {
      await start(settings(), `Автопостинг · ${channels.length} каналов`)
      return
    }
    // «По расписанию» — сохраняем/обновляем правило автоматизации (публикация сохраняется).
    setSavingRule(true)
    try {
      const payload = {
        // Автоимя должно РАЗЛИЧАТЬ посты: раньше все безымянные звались «Пост в N канал(ов)»,
        // и в списке висели одинаковые карточки, а диалог удаления подставлял то же неуникальное
        // имя — для необратимого действия непонятно, что именно стираешь (баг 10.5-a).
        name: name.trim() || `${text.trim().slice(0, 40) || 'Пост'} → ${channels[0] ?? '—'}${channels.length > 1 ? ` +${channels.length - 1}` : ''}`,
        moduleKey: 'autoposting',
        campaignId: null,
        accountIds: [...selected],
        settings: settings(),
        schedule: buildSchedule(),
      }
      if (editingId) {
        await updateAutomationRule(editingId, payload)
        pushToast({ type: 'success', title: 'Запланированный пост обновлён' })
      } else {
        await createAutomationRule(payload)
        pushToast({ type: 'success', title: 'Пост запланирован', desc: scheduleLabel(buildSchedule()) })
      }
      resetForm()
      await loadRules()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' })
    } finally { setSavingRule(false) }
  }

  const seg = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-all ${active ? 'bg-spark-gradient text-[#04150c]' : 'text-muted hover:text-fg'}`

  const primaryLabel = mode === 'schedule' ? (editingId ? 'Сохранить изменения' : 'Запланировать') : 'Опубликовать'

  const launchStats = [
    { icon: <Users size={18} />, color: 'text-iris-300', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
    { icon: <Radio size={18} />, color: 'text-cyan-300', label: 'Каналы', value: String(channels.length), warn: channels.length === 0 },
    { icon: <CalendarClock size={18} />, color: 'text-amber-300', label: 'Режим', value: mode === 'now' ? 'Сейчас' : 'Расписание' },
  ]

  const blockedBy = !canStart ? [
    ...(canWrite ? [] : ['только администратор']),
    ...(selected.size ? [] : ['выберите аккаунты']),
    ...(channels.length ? [] : ['добавьте каналы']),
    ...(text.trim() ? [] : ['введите текст поста']),
  ] : []

  return (
    <div>
      <PageHeader
        title="Автопостинг"
        subtitle="Публикация постов в СВОИ каналы/группы. Безопасно — не спам."
        icon={<Megaphone size={22} />}
      />

      <Card className="mb-4 flex items-start gap-2 border-iris-500/30 bg-iris-500/5 p-3 text-sm text-iris-200/90">
        <Info size={16} className="mt-0.5 shrink-0" />
        <span>Аккаунт-отправитель должен быть <b>админом</b> канала с правом публикации. Постим только в свои каналы — риска бана нет.</span>
      </Card>

      <div className="space-y-4">
        <TaskStartedModal task={justStarted} moduleTitle="Автопостинг" onClose={dismissJustStarted} />
        <SavePresetModal open={presetModalOpen} onClose={() => setPresetModalOpen(false)}
          onSave={(name, color, owner) => savePreset(name, settings(), color, owner)} />
        {/* ТЗ 06.08 §10: выбор шаблона — вверху, до всех настроек (TPL-001). */}
        <PresetBar presets={presets} onApply={applyPreset} onSave={handleSave}
          onEdit={editPreset} onDelete={deletePreset} disabled={running} />

        {/* MR-149: мини-калькулятор цены действия — в шапке, перед «Выбором аккаунтов». */}
        <ActionPriceCalc moduleKey="autoposting" />

        {/* 1. Аккаунты — единый полноширинный выбор, как во всех модулях. */}
        <div id="sec-accounts" className="scroll-mt-24">
          <AccountPicker selected={selected} onChange={setSelected} selectedTitle="Выбрано для постинга" />
        </div>

        {/* 2. Каналы (аналог блока «Цели/Каналы» в общей структуре). */}
        <div id="sec-targets" className="scroll-mt-24">
          <SectionCard icon={<Target size={18} />} title="Каналы/группы" badge={String(channels.length)} required>
            <div className="mb-1 text-xs text-white/50">Свои каналы/группы, где аккаунт — админ с правом публикации</div>
            <textarea className="input min-h-[80px] font-mono text-sm" value={channelsText} onChange={(e) => setChannelsText(e.target.value)} placeholder={'@my_channel\nhttps://t.me/my_group'} />
            {/* ЧС внутри блока целей — единообразно с остальными модулями. На сервере
                он тут работал и раньше (через общий `targets()`), не хватало блока. */}
            <div className="mt-3">
              <BlacklistEditor title="Чёрный список каналов" compact />
            </div>
          </SectionCard>
        </div>

        {/* 3. Текст поста. */}
        <div id="sec-message" className="scroll-mt-24">
          <SectionCard icon={<MessageSquareText size={18} />} title="Текст поста" required>
            <MessageComposer value={text} onChange={setText} media={media} onMedia={setMedia} label="Текст поста" placeholder="Текст, который опубликуется в каналах…" />
          </SectionCard>
        </div>

        {/* Один блок на все модули (правка 19.08): защита и задержки — одно решение.
            Раньше у автопостинга защиты в интерфейсе не было вовсе, а паузы жили внутри
            «Публикации и темпа» — четвёртый по счёту способ настроить одно и то же. */}
        <ProtectionTimings
          timing={{
            delays: postingDelays,
            onDelays: (updater) => {
              const next = typeof updater === 'function' ? updater(postingDelays) : updater
              const a = next.action
              if (a) { setDelayMin(Math.max(1, a[0])); setDelayMax(Math.max(a[0], a[1])) }
            },
            showAction: true,
            showComment: false,
            showJoin: false,
            labels: { action: 'Задержка между публикациями' },
            delayPresets: ['Агрессивный', 'Сбалансированный', 'Консервативный'],
            delayPreset,
            onDelayPreset: setDelayPreset,
          }}
        />

        {/* 4. Публикация и темп — необязательный шаг («Сейчас» ничего не требует). */}
        <div id="sec-settings" className="scroll-mt-24">
          <SectionCard icon={<CalendarClock size={18} />} title="Публикация" badge={mode === 'now' ? 'Сейчас' : 'Расписание'}>
            <div className="mb-3 flex gap-1 rounded-xl bg-elevated p-1">
              <button onClick={() => setMode('now')} className={seg(mode === 'now')}>Сейчас</button>
              <button onClick={() => setMode('schedule')} className={seg(mode === 'schedule')}>По расписанию</button>
            </div>

            {mode === 'schedule' && (
              <div className="mb-3 space-y-3 rounded-xl border border-line bg-elevated/40 p-3">
                <label className="block text-xs text-white/50">Название поста (чтобы найти его в списке)
                  <input value={name} onChange={(e) => setName(e.target.value)} className="input mt-1 h-9" placeholder="Утренний пост" />
                </label>
                <div className="flex gap-1 rounded-lg bg-elevated p-1">
                  <button onClick={() => setSchedType('once')} className={seg(schedType === 'once')}>Один раз</button>
                  <button onClick={() => setSchedType('daily')} className={seg(schedType === 'daily')}>Ежедневно</button>
                  <button onClick={() => setSchedType('interval')} className={seg(schedType === 'interval')}>Каждые N мин</button>
                </div>
                {schedType === 'once' && (
                  <label className="block text-xs text-white/50">Дата и время публикации
                    <input type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} className="input mt-1 h-9" />
                    {/* §8.4: поле рисуется браузером и в локали en-US показывает AM/PM, тогда как весь
                        интерфейс и карточки расписаний — 24-часовые. На прогоне 21–22.07 (баг 10.3-a)
                        это дало промах ровно на час: «11:09 PM» вместо 22:09. Подписываем, что реально
                        сохранится, — сверить введённое с показанным иначе негде. */}
                    {schedAt && !Number.isNaN(new Date(schedAt).getTime()) && (
                      <span className="mt-1 block text-[11px] text-iris-300">
                        Опубликуется: {new Date(schedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                    )}
                  </label>
                )}
                {schedType === 'daily' && (
                  <label className="block text-xs text-white/50">Время публикации
                    <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="input mt-1 h-9" />
                  </label>
                )}
                {schedType === 'interval' && (
                  <label className="block text-xs text-white/50">Интервал, минут
                    <NumberField value={schedInterval} onChange={setSchedInterval} min={1} />
                  </label>
                )}
              </div>
            )}

            {/* Темп уехал в общий блок «Защита и тайминги» — держать паузы в двух местах
                значит рано или поздно задать их по-разному (правка 19.08). */}
            {!canWrite && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Публикацию создаёт только администратор (единый отправитель). У вас нет прав на отправку.
              </div>
            )}
            {editingId && (
              <button onClick={resetForm} className="btn-ghost mt-3 h-9 text-sm" title="Отменить редактирование запланированного поста"><X size={15} /> Отменить редактирование</button>
            )}
          </SectionCard>
        </div>

        {/* §11: запланированные посты — их можно отредактировать (аккаунты, каналы, текст, время),
            опубликовать досрочно или удалить. Это те же правила автоматизации, вид со стороны постинга. */}
        <SectionCard
          icon={<CalendarClock size={18} />}
          title="Запланированные посты"
          badge={String(activeRules.length)}
          right={spentRules.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowSpent((v) => !v)}
              className="text-xs font-semibold text-muted hover:text-fg"
            >
              {showSpent ? 'Скрыть отработавшие' : `Показать отработавшие (${spentRules.length})`}
            </button>
          ) : undefined}
        >
          {loadingRules ? (
            <p className="text-sm text-muted">Загрузка…</p>
          ) : visibleRules.length === 0 ? (
            <p className="text-sm text-muted">Пока ничего не запланировано. Выберите «По расписанию» выше — пост появится здесь и опубликуется сам.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleRules.map((r) => (
                <div key={r.id} className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${editingId === r.id ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated/50'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-fg">{r.name}</div>
                    <div className="text-xs text-muted">
                      {scheduleLabel(r.schedule)} · {(r.settings?.targets || []).length} канал(ов) · {(r.accountIds || []).length} аккаунт(ов)
                      {r.nextRun ? ` · следующий ${new Date(r.nextRun).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                      {r.enabled ? '' : ' · выключен'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => void publishRuleNow(r)} className="btn-ghost h-8 px-2 text-xs" title="Опубликовать сейчас, не дожидаясь расписания"><Play size={14} /></button>
                    <button onClick={() => editRule(r)} className="btn-ghost h-8 px-2 text-xs" title="Редактировать пост: аккаунты, каналы, текст, время"><Pencil size={14} /></button>
                    <button onClick={() => void removeRule(r)} className="btn-ghost h-8 px-2 text-xs text-rose-300 hover:bg-rose-500/10" title="Удалить запланированный пост"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* 5. Запуск — плавающая нижняя панель со степпером (без обёртки-карточки; идёт ПОСЛЕ
            списка «Запланированные посты», чтобы фиксированный бар их не перекрывал). */}
        <div id="sec-run" className="scroll-mt-24">
          <LaunchPanel
            running={running}
            starting={mode === 'now' ? starting : savingRule}
            canStart={canStart}
            onStart={() => void launch()}
            onStop={stop}
            onSave={handleSave}
            primaryLabel={primaryLabel}
            steps={!running ? <LaunchSteps steps={markCurrentStep([
              { label: 'Аккаунты', done: selected.size > 0, anchor: 'sec-accounts' },
              { label: 'Каналы', done: channels.length > 0, anchor: 'sec-targets' },
              { label: 'Текст', done: text.trim().length > 0, anchor: 'sec-message' },
              { label: mode === 'now' ? 'Публикация' : 'Расписание', done: true, optional: true, anchor: 'sec-settings' },
              { label: 'Запуск', done: false, anchor: 'sec-run' },
            ])} /> : null}
            blockedBy={blockedBy}
            cost={<LaunchCost compact moduleKey="autoposting" actions={channels.length} />}
            stats={launchStats}
            task={task}
            presets={presets}
            onApplyPreset={applyPreset}
          />
        </div>
      </div>
    </div>
  )
}
