import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Rocket, Check, Clock, Power, Trash2, CalendarClock, Plus, Pencil, ArrowLeft, Lock, LockOpen, Zap, Target as TargetIcon } from 'lucide-react'
import { activeAccounts, trashedAccounts, useApp } from '@/mocks/store'
import { PageHeader, Card, Select, Badge, EmptyState } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { moduleTitle } from '@/shared/config/modules'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import {
  launchCampaign, fetchSchedules, createSchedule, updateSchedule, deleteSchedule,
  fetchCampaigns, createCampaign, updateCampaign, deleteCampaign, CAMPAIGN_STATUSES,
  FOLLOW_UP_MAX, FOLLOW_UP_DEFAULT,
  parseIntent, type IntentSuggestion,
  type CampaignResult, type CampaignSchedule, type Campaign, type CampaignStatus, type PinnedMap,
} from '@/api/campaignsApi'
import { fetchModulePresets, type ModulePreset } from '@/api/modulesApi'
import { confirmDialog, promptDialog } from '@/shared/lib/dialog'
import { DedupeButton } from '@/shared/ui/DedupeButton'
import { fetchAccountGroups, createAccountGroup, accountsOfGroupsLocal, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchChannels, type Channel } from '@/api/channelsApi'
import { fetchAgents, type Agent } from '@/api/agentsApi'
import { FolderPicker } from '@/features/modules/shared/FolderPicker'
import { isAvailableForWork } from '@/shared/lib/accountStatus'

// Модули, которые осмысленно ставить в кампанию — все действующие «к цели».
// Парсеры и AIR сюда не входят: они собирают аудиторию/оценивают, а не работают на этап.
// Рассылка (`mailing`) стоит рядом: связка «комментинг приводит людей, рассылка им пишет».
const CAMPAIGN_MODULES = [
  'neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mailing',
  'mass-react', 'mass-looking', 'warming', 'autoposting',
]

/** Рассылка: её «цель» — получатель (номер/юзернейм), а не канал, поэтому получателей задаём отдельно. */
const MAILING_KEY = 'mailing'

/**
 * Модули, которые сами ведут переписку. Для них «добавить чатинг» бессмысленно:
 * получилось бы два диалоговых модуля на одних аккаунтах — оба отвечали бы
 * одному человеку.
 */
const DIALOG_MODULES = new Set(['neuro-chatting', 'neuro-dialogs'])

export function CampaignPage() {
  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const appData = useApp((s) => s.data)
  const accounts = activeAccounts(appData)
  // §5 (fix осиротевших ссылок): считаем только РЕАЛЬНО существующие аккаунты
  // (активные + в корзине). Полностью удалённые id, оставшиеся в кампании/группе,
  // не раздувают счётчики. Хранилище не мутируем — только показ.
  const knownIds = useMemo(() => new Set([...activeAccounts(appData), ...trashedAccounts(appData)].map((a) => a.id)), [appData])
  const realCount = (ids: string[]) => ids.filter((id) => knownIds.has(id)).length
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalId, setGoalId] = useState('')
  const [mods, setMods] = useState<Set<string>>(new Set(['neuro-commenting']))
  const [targetsText, setTargetsText] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [launching, setLaunching] = useState(false)
  const [result, setResult] = useState<CampaignResult | null>(null)
  /** Разовый запуск открыт отдельным экраном — страница показывает только кампании. */
  const [oneOffOpen, setOneOffOpen] = useState(false)
  const [schedules, setSchedules] = useState<CampaignSchedule[]>([])
  const [runAt, setRunAt] = useState('')
  const [repeat, setRepeat] = useState<'none' | 'daily'>('none')
  const [scheduling, setScheduling] = useState(false)

  // ── §5: сущность «Кампания» — список + вьюшка создания/редактирования ──
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({})
  const [formOpen, setFormOpen] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null)
  const [cName, setCName] = useState('')
  // §9.0: собственные каналы кампании — раньше их было негде задать (тест 1.2).
  const [cTargets, setCTargets] = useState('')
  // D5 (SPEC §2.4): «я хочу создать кампанию, а не настроить модуль». Оператор пишет
  // намерение словами, система предлагает раскладку — но НЕ применяет молча: раскладка
  // чужого намерения по боевым модулям без подтверждения была бы опасной.
  const [cIntent, setCIntent] = useState('')
  const [suggestion, setSuggestion] = useState<IntentSuggestion | null>(null)
  const [intentBusy, setIntentBusy] = useState(false)

  const askIntent = async () => {
    if (!cIntent.trim()) return
    setIntentBusy(true)
    try { setSuggestion(await parseIntent(cIntent)) }
    catch (e) { pushToast({ type: 'error', title: 'Не разобрал', desc: e instanceof Error ? e.message : '' }) }
    finally { setIntentBusy(false) }
  }

  /** Применить предложение: модули и каналы подставляются в форму, дальше правит человек. */
  const applySuggestion = () => {
    if (!suggestion) return
    const keys = suggestion.modules.map((m) => m.moduleKey).filter((k) => CAMPAIGN_MODULES.includes(k))
    if (keys.length) setCModules(keys)
    if (suggestion.targets.length) {
      setCTargets((prev) => {
        const had = prev.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
        return [...new Set([...had, ...suggestion.targets])].join('\n')
      })
    }
    pushToast({ type: 'success', title: 'Раскладка подставлена', desc: 'Проверьте модули и каналы ниже' })
  }
  const [cGoalId, setCGoalId] = useState('')
  const [cModule, setCModule] = useState('neuro-commenting')
  /** Модули кампании: несколько, работают вместе. `cModule` — первый из них. */
  const [cModules, setCModules] = useState<string[]>(['neuro-commenting'])
  // A3.2 (SPEC §2.6): агент выбирается на СТРОКЕ модуля — под одной целью можно вести
  // «500 хвалят» и «500 спорят» разными персонами.
  const [cModuleAgents, setCModuleAgents] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<Agent[]>([])
  const [cAccounts, setCAccounts] = useState<string[]>([])
  const [cPinned, setCPinned] = useState(true)
  const [cStatus, setCStatus] = useState<CampaignStatus>('draft')
  const [cSaving, setCSaving] = useState(false)
  // §9: догоняющий чатинг — второй модуль кампании. Основной выбор не трогаем.
  // §0: настройки модуля для кампании. Держим их пресетом: у каждого модуля свой
  // набор полей, дублировать все формы внутри кампании — верный способ разойтись
  // с самим модулем. Пресет собирается там, где его удобно настраивать и проверять.
  // Теперь пресет у КАЖДОГО модуля свой (moduleKey → …): добавил модуль — под ним свой
  // блок настроек. Раньше пресет был один на кампанию, и второй модуль шёл с дефолтом.
  const [cModuleSettings, setCModuleSettings] = useState<Record<string, Record<string, unknown>>>({})
  const [cModulePresetId, setCModulePresetId] = useState<Record<string, string>>({})
  const [modulePresets, setModulePresets] = useState<Record<string, ModulePreset[]>>({})
  // Получатели рассылки — отдельно от целевых каналов: номера и юзернеймы разными строками.
  const [cMailNumbers, setCMailNumbers] = useState('')
  const [cMailUsernames, setCMailUsernames] = useState('')
  const [cChat, setCChat] = useState(false)
  const [cChatGoal, setCChatGoal] = useState('')
  const [cChatScope, setCChatScope] = useState<'unread' | 'all'>('unread')
  // Дожим и дедлайн переехали сюда из агента и цели (24.07): оркестрация — дело кампании.
  const [cDeadline, setCDeadline] = useState('')
  const [cFollowUp, setCFollowUp] = useState(false)
  const [cFollowUpLimit, setCFollowUpLimit] = useState(FOLLOW_UP_DEFAULT)
  const [cFollowUpText, setCFollowUpText] = useState('')
  const [cChatLimitMode, setCChatLimitMode] = useState<'untilTarget' | 'count'>('untilTarget')
  const [cChatMaxReplies, setCChatMaxReplies] = useState(5)
  const [cChatMaxDialogs, setCChatMaxDialogs] = useState(0)
  const [pickMode, setPickMode] = useState(0) // 0 — числом из пула, 1 — вручную
  const [takeN, setTakeN] = useState(5)
  // §5: третий режим выбора аккаунтов — папкой (группой). §12: группы — отдельная сущность.
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const loadGroups = () => { void fetchAccountGroups().then(({ groups: gs }) => setGroups(gs)).catch(() => {}) }

  const loadCampaigns = () => {
    void fetchCampaigns().then(({ campaigns: cs, pinned }) => { setCampaigns(cs); setPinnedMap(pinned) }).catch(() => {})
  }
  const loadSchedules = () => { void fetchSchedules().then(setSchedules).catch(() => {}) }
  useEffect(() => {
    void fetchGoals().then(setGoals).catch(() => {})
    void fetchChannels().then(setChannels).catch(() => {})
    loadSchedules()
    loadCampaigns()
    loadGroups()
    void fetchAgents().then(setAgents).catch(() => {})
  }, [])

  // Свободные для работы аккаунты — их и распределим. Не только «не занят задачей»,
  // но и рабочий статус: спамблок/карантин/непрогретый в кампанию лить нельзя.
  const freeIds = useMemo(() => accounts.filter(isAvailableForWork).map((a) => a.id), [accounts])
  // Цели = вручную введённые + выбранные из базы каналов (без дублей).
  const targets = useMemo(() => {
    const typed = targetsText.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean)
    return [...new Set([...typed, ...picked])]
  }, [targetsText, picked])

  const pickChan = (u: string) => setPicked((prev) => {
    const n = new Set(prev); n.has(u) ? n.delete(u) : n.add(u); return n
  })

  const toggle = (k: string) => setMods((prev) => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  const perModule = mods.size ? Math.floor(freeIds.length / mods.size) : 0
  const canLaunch = mods.size > 0 && freeIds.length > 0 && targets.length > 0 && !launching

  const launch = async () => {
    setLaunching(true); setResult(null)
    try {
      const r = await launchCampaign({
        goalId: goalId || null,
        accountIds: freeIds,
        targets,
        modules: [...mods].map((moduleKey) => ({ moduleKey })),
      })
      setResult(r)
      pushToast({ type: 'success', title: 'Кампания запущена', desc: `Задач: ${r.tasks.length}${r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''}` })
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось запустить кампанию', desc: err instanceof Error ? err.message : '' })
    } finally { setLaunching(false) }
  }

  const campaignBody = () => ({
    goalId: goalId || null,
    accountIds: freeIds,
    targets,
    modules: [...mods].map((moduleKey) => ({ moduleKey })),
  })

  const schedule = async () => {
    const ts = runAt ? new Date(runAt).getTime() : 0
    if (!ts) return pushToast({ type: 'error', title: 'Укажите дату и время запуска' })
    if (mods.size === 0 || targets.length === 0) return pushToast({ type: 'error', title: 'Выберите модули и цели' })
    setScheduling(true)
    try {
      await createSchedule({ name: goals.find((g) => g.id === goalId)?.name || 'Кампания', body: campaignBody(), runAt: ts, repeat })
      pushToast({ type: 'success', title: 'Кампания запланирована', desc: new Date(ts).toLocaleString() })
      setRunAt('')
      loadSchedules()
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
    finally { setScheduling(false) }
  }

  const toggleSchedule = async (s: CampaignSchedule) => {
    try { const up = await updateSchedule(s.id, { enabled: !s.enabled }); setSchedules((prev) => prev.map((x) => (x.id === up.id ? up : x))) }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }
  const removeSchedule = async (s: CampaignSchedule) => {
    if (!window.confirm('Удалить расписание кампании? Действие необратимо.')) return
    try { await deleteSchedule(s.id); setSchedules((prev) => prev.filter((x) => x.id !== s.id)) }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }

  // §5: свободные аккаунты = свободные ДЛЯ РАБОТЫ (не занят задачей, рабочий статус)
  // и не закреплённые ЧУЖОЙ кампанией. Раньше показывались все активные подряд, включая
  // спамблок/карантин/занятых — их всё равно нельзя запустить, а в списке они путали.
  const freeForCampaign = useMemo(
    () => accounts.filter((a) => {
      if (!isAvailableForWork(a)) return false
      const pin = pinnedMap[a.id]
      return !pin || pin.campaignId === editingCampaign?.id
    }),
    [accounts, pinnedMap, editingCampaign],
  )

  const openNewCampaign = () => {
    setEditingCampaign(null)
    setCName(''); setCGoalId(''); setCModules(['neuro-commenting']); setCModuleAgents({}); setCAccounts([]); setCTargets('')
    setCModuleSettings({}); setCModulePresetId({}); setCMailNumbers(''); setCMailUsernames('')
    setCPinned(true); setCStatus('draft'); setPickMode(0); setTakeN(5)
    setCChat(false); setCChatGoal(''); setCChatScope('unread')
    setCChatLimitMode('untilTarget'); setCChatMaxReplies(5); setCChatMaxDialogs(0)
    setCDeadline(''); setCFollowUp(false); setCFollowUpLimit(FOLLOW_UP_DEFAULT); setCFollowUpText('')
    setFormOpen(true)
  }
  // Первый модуль — основной (приводит людей). На него смотрят чат-блок и заголовки.
  useEffect(() => { setCModule(cModules[0] || '') }, [cModules])

  // Пресеты грузим для КАЖДОГО выбранного модуля: у каждого свой блок настроек.
  useEffect(() => {
    let cancelled = false
    void Promise.all(cModules.map((k) =>
      fetchModulePresets(k).then((p) => [k, p] as const).catch(() => [k, [] as ModulePreset[]] as const),
    )).then((pairs) => { if (!cancelled) setModulePresets(Object.fromEntries(pairs)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cModules.join(',')])

  const openEditCampaign = (c: Campaign) => {
    setEditingCampaign(c)
    setCName(c.name); setCGoalId(c.goalId || ''); setCModules(c.modules?.length ? c.modules : [c.moduleKey].filter(Boolean)); setCModuleAgents(c.moduleAgents || {}); setCAccounts(c.accountIds || [])
    setCTargets((c.targets || []).join('\n'))
    // Пресеты каждого модуля. Обратной привязки «settings → id пресета» нет, поэтому
    // селект показывает «По умолчанию», но сохранённые настройки применяются как есть.
    setCModuleSettings(c.moduleSettings || (c.settings && Object.keys(c.settings).length ? { [c.moduleKey]: c.settings } : {}))
    setCModulePresetId({})
    // Получатели рассылки: раскладываем обратно на номера и юзернеймы (буквы → юзернейм).
    const mail = c.moduleTargets?.[MAILING_KEY] || []
    setCMailNumbers(mail.filter((t) => !/[a-zA-Zа-яА-Я_]/.test(t)).join('\n'))
    setCMailUsernames(mail.filter((t) => /[a-zA-Zа-яА-Я_]/.test(t)).join('\n'))
    setCDeadline(c.deadline || ''); setCFollowUp(c.followUp?.enabled === true)
    setCFollowUpLimit(c.followUp?.limit || FOLLOW_UP_DEFAULT); setCFollowUpText(c.followUp?.instructions || '')
    setCPinned(c.pinned); setCStatus(c.status); setPickMode(1); setTakeN(c.accountIds?.length || 5)
    const ch = c.chat?.settings || {}
    setCChat(c.chat?.enabled === true)
    setCChatGoal(ch.dialogGoal || '')
    setCChatScope(ch.replyScope === 'all' ? 'all' : 'unread')
    setCChatLimitMode(ch.replyLimitMode === 'count' ? 'count' : 'untilTarget')
    setCChatMaxReplies(ch.maxRepliesPerLead || 5)
    setCChatMaxDialogs(ch.maxActiveDialogs || 0)
    setFormOpen(true)
  }

  const saveCampaign = async () => {
    if (!cName.trim()) return pushToast({ type: 'error', title: 'Укажите название кампании' })
    if (!cModule) return pushToast({ type: 'error', title: 'Кампания должна настраивать модуль' })
    // Режим «числом» — берём N свободных аккаунтов из пула.
    const ids = pickMode === 0
      ? freeForCampaign.slice(0, Math.max(0, takeN)).map((a) => a.id)
      : pickMode === 2
        ? accountsOfGroupsLocal(groups, pickedGroups).filter((id) => freeForCampaign.some((a) => a.id === id))
        : cAccounts
    // Получатели рассылки — отдельная цель модуля mailing (номера + юзернеймы).
    const mailTargets = cModules.includes(MAILING_KEY)
      ? [...cMailNumbers.split(/[\n,;]+/), ...cMailUsernames.split(/[\n,;]+/)].map((x) => x.trim()).filter(Boolean)
      : []
    setCSaving(true)
    try {
      const payload = {
        name: cName.trim(), goalId: cGoalId || null, moduleKey: cModules[0] || '', modules: cModules, moduleAgents: cModuleAgents, accountIds: ids, pinned: cPinned, status: cStatus,
        moduleSettings: cModuleSettings,
        // Совместимость: старые места читают одиночный `settings` — кладём пресет первого модуля.
        settings: cModuleSettings[cModules[0]] || {},
        moduleTargets: (mailTargets.length ? { [MAILING_KEY]: mailTargets } : {}) as Record<string, string[]>,
        targets: cTargets.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
        chat: {
          enabled: cChat,
          settings: {
            dialogGoal: cChatGoal.trim(),
            replyScope: cChatScope,
            replyLimitMode: cChatLimitMode,
            maxRepliesPerLead: cChatLimitMode === 'count' ? cChatMaxReplies : 0,
            maxActiveDialogs: cChatMaxDialogs,
          },
        },
        // Оркестрация — дело кампании: срок этапа и настойчивость в диалоге.
        deadline: cDeadline || null,
        followUp: { enabled: cFollowUp, limit: cFollowUpLimit, instructions: cFollowUpText.trim() },
      }
      if (editingCampaign) {
        await updateCampaign(editingCampaign.id, payload)
        pushToast({ type: 'success', title: 'Кампания обновлена', desc: cName.trim() })
      } else {
        await createCampaign(payload)
        pushToast({ type: 'success', title: 'Кампания создана', desc: cName.trim() })
      }
      setFormOpen(false)
      loadCampaigns()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не сохранено', desc: e instanceof Error ? e.message : '' })
    } finally { setCSaving(false) }
  }

  // §12: создать группу прямо из выбранных аккаунтов — чтобы не заводить их в чужом экране.
  const saveSelectionAsGroup = async () => {
    const name = await promptDialog({ title: 'Новая группа аккаунтов', message: 'Название группы', placeholder: 'Напр. Прогрев RU' })
    if (!name?.trim()) return
    try {
      await createAccountGroup({ name: name.trim(), accountIds: cAccounts })
      loadGroups()
      pushToast({ type: 'success', title: 'Группа создана', desc: `${name.trim()} · ${cAccounts.length} акк.` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не создано', desc: e instanceof Error ? e.message : '' })
    }
  }

  /**
   * §9: запустить сохранённую кампанию — основной модуль + (если включён) чатинг.
   * Аккаунты кампании делятся между модулями на сервере (`splitAccounts`), цели берём из цели кампании.
   */
  const launchSaved = async (c: Campaign) => {
    // Все модули кампании разом: они и должны работать вместе на общем пуле.
    const keys = c.modules?.length ? c.modules : [c.moduleKey].filter(Boolean)
    // A3.2: агент выбирается на СТРОКЕ модуля, поэтому кладём его в настройки задачи —
    // оттуда воркер возьмёт тон и дожим (A3.3). Так под одной целью можно вести
    // «500 хвалят» и «500 спорят» разными агентами (SPEC §2.6).
    const modules = [
      ...keys.map((moduleKey) => ({
        moduleKey,
        // Свои цели модуля (рассылка: получатели). Пусто — модуль возьмёт общие каналы кампании.
        ...(c.moduleTargets?.[moduleKey]?.length ? { targets: c.moduleTargets[moduleKey] } : {}),
        // Пресет ИМЕННО этого модуля (фолбэк на общий settings для старых кампаний).
        settings: { ...(c.moduleSettings?.[moduleKey] || c.settings), agentId: c.moduleAgents?.[moduleKey] || undefined },
      })),
      ...(c.chat?.enabled ? [{ moduleKey: 'neuro-dialogs', settings: c.chat.settings }] : []),
    ]
    const ids = c.accountIds.filter((id) => knownIds.has(id))
    if (!ids.length) return pushToast({ type: 'error', title: 'В кампании нет аккаунтов' })
    if (!(await confirmDialog({
      title: `Запустить «${c.name}»?`,
      message: `${modules.map((m) => moduleTitle(m.moduleKey)).join(' + ')} · ${ids.length} акк.`,
      confirmLabel: 'Запустить',
    }))) return
    try {
      // Каналы — свойство КАМПАНИИ (24.07). Раньше был фолбэк на каналы цели, но
      // цель про группы «по-хорошему знать не должна», и это поле из неё убрано.
      const targets = c.targets || []
      const r = await launchCampaign({
        goalId: c.goalId, campaignId: c.id, accountIds: ids, targets, modules,
        // Дедлайн и дожим кампании доезжают до воркеров в настройках задачи.
        deadline: c.deadline || null,
        followUp: c.followUp || null,
      })
      setResult(r)
      pushToast({
        type: r.tasks.length ? 'success' : 'error',
        title: r.tasks.length ? 'Кампания запущена' : 'Ничего не запущено',
        desc: `Задач: ${r.tasks.length}${r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''}`,
      })
      if (r.tasks.length && c.status === 'draft') { await updateCampaign(c.id, { status: 'active' }); loadCampaigns() }
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось запустить', desc: e instanceof Error ? e.message : '' })
    }
  }

  const removeCampaign = async (c: Campaign) => {
    if (!(await confirmDialog({ title: 'Удалить кампанию?', message: `«${c.name}» будет удалена, её аккаунты освободятся.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteCampaign(c.id); pushToast({ type: 'success', title: 'Кампания удалена' }); loadCampaigns() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }

  const goalNameOf = (id?: string | null) => (id ? goals.find((g) => g.id === id)?.name || '—' : null)

  // §5: создание/редактирование кампании — полноэкранная вьюшка, не модалка.
  if (formOpen) {
    return (
      <div>
        <button onClick={() => setFormOpen(false)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к кампаниям</button>
        <PageHeader
          title={editingCampaign ? 'Изменить кампанию' : 'Новая кампания'}
          subtitle="Кампания принадлежит цели: основной модуль + при желании чатинг. Закреплённые аккаунты выходят из общего пула."
          icon={<Rocket size={22} />}
        />
        <Card className="space-y-4 p-4">
          {/* D5 (SPEC §2.4): «я хочу создать кампанию, а не настроить модуль».
              Оператор описывает задачу словами — система предлагает раскладку, но
              подставляет её только по кнопке: молча разложить чужое намерение
              по боевым модулям было бы опасно. Ручной путь ниже остаётся основным. */}
          <div className="rounded-xl border border-iris-500/30 bg-iris-500/5 p-3">
            <div className="mb-1.5 text-xs font-semibold text-iris-200">
              Опишите задачу словами <span className="font-normal text-white/40">— система предложит модули и цели</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                className="input h-10 min-w-[280px] flex-1"
                value={cIntent}
                onChange={(e) => setCIntent(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void askIntent() } }}
                placeholder="Напр. комментировать @cryptoz и вести людей в личку, нужно 200 переходов"
              />
              <button type="button" onClick={() => void askIntent()} disabled={intentBusy || !cIntent.trim()} className="btn-ghost h-10 shrink-0 px-4 disabled:opacity-40">
                {intentBusy ? 'Разбираю…' : 'Разобрать'}
              </button>
            </div>

            {suggestion && (
              <div className="mt-3 rounded-lg border border-line bg-elevated/50 p-3">
                {suggestion.understood ? (
                  <>
                    <div className="mb-2 text-xs text-white/50">Поняли так:</div>
                    <div className="flex flex-col gap-1.5">
                      {suggestion.modules.map((m) => (
                        <div key={m.moduleKey} className="flex flex-wrap items-baseline gap-2 text-sm">
                          <span className="font-semibold text-fg">{moduleTitle(m.moduleKey)}</span>
                          <span className="text-xs text-muted">— {m.why}</span>
                        </div>
                      ))}
                    </div>
                    {!!suggestion.targets.length && (
                      <div className="mt-2 text-xs text-muted">Цели из текста: <span className="text-fg">{suggestion.targets.join(', ')}</span></div>
                    )}
                    {suggestion.result && (
                      <div className="mt-1 text-xs text-muted">
                        Измеримый результат: <span className="text-fg">{suggestion.result.amount} {suggestion.result.unit}</span>
                        {suggestion.needsLink && ' — считается по отслеживаемой ссылке'}
                      </div>
                    )}
                    <button type="button" onClick={applySuggestion} className="btn-primary mt-3 h-9 text-sm">
                      Подставить в форму
                    </button>
                  </>
                ) : (
                  <div className="text-sm text-amber-300">Не понял, что нужно сделать — опишите действие или заполните форму вручную.</div>
                )}
                {suggestion.warnings.map((w) => (
                  <div key={w} className="mt-2 text-xs text-amber-300">⚠ {w}</div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Название *</div>
              <input className="input" value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Напр. Крипто · прогрев" />
            </div>
            <div>
              <div className="mb-1 text-xs text-white/50">Цель кампании</div>
              <Select value={cGoalId} onChange={setCGoalId} placeholder="Без цели" options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Статус</div>
              <Select value={cStatus} onChange={(v) => setCStatus(v as CampaignStatus)} options={CAMPAIGN_STATUSES.map((s) => ({ value: s, label: { draft: 'Черновик', active: 'Активна', paused: 'Пауза', done: 'Завершена' }[s] }))} />
            </div>
          </div>

          {/* §0: модулей может быть НЕСКОЛЬКО и работают они вместе на общем пуле:
              комментинг приводит людей, рассылка им пишет, чатинг ловит ответы.
              Раньше поле было одиночным — и такую связку собрать было нельзя. */}
          <div>
            <div className="mb-1 text-xs text-white/50">
              Модули * <span className="text-white/30">(работают вместе, аккаунты делятся между ними)</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {CAMPAIGN_MODULES.map((k) => {
                const on = cModules.includes(k)
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      const next = on ? cModules.filter((x) => x !== k) : [...cModules, k]
                      setCModules(next)
                      // Диалоговый модуль сам ведёт переписку — отдельный чатинг ему не нужен.
                      if (next.some((m) => DIALOG_MODULES.has(m))) setCChat(false)
                    }}
                    className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
                      on ? 'border-spark-500/50 bg-spark-500/12 text-spark-200' : 'border-line bg-elevated text-muted hover:border-spark-500/30'
                    }`}
                  >
                    {on ? '✓ ' : ''}{moduleTitle(k)}
                  </button>
                )
              })}
            </div>
            {!cModules.length && <div className="mt-1 text-xs text-rose-300">Выберите хотя бы один модуль</div>}
          </div>

          {/* Под каждым выбранным модулем — свой блок: кто ведёт (агент) + пресет настроек.
              Добавил модуль — появился ещё один блок. Раньше пресет был один на кампанию,
              и второй модуль запускался с настройками по умолчанию, даже если для него был
              сохранён свой пресет (A3.2 — агент всегда был свой у каждого модуля). */}
          {cModules.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-white/50">Настройки модулей <span className="text-white/30">— агент и пресет у каждого свои</span></div>
              {!agents.length && (
                <div className="text-xs text-amber-300">Агентов пока нет — заведите их в разделе «Агенты», иначе тон будет по умолчанию.</div>
              )}
              {cModules.map((k) => {
                const presets = modulePresets[k] || []
                return (
                  <div key={k} className="rounded-xl border border-line bg-elevated/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-fg">{moduleTitle(k)}</span>
                      <a href={`/panel/modules/${k}`} className="text-xs font-semibold text-spark-300 hover:underline">
                        Настроить и сохранить пресет →
                      </a>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-xs text-white/50">Кто ведёт <span className="text-white/30">(AI-персона)</span></div>
                        <Select
                          value={cModuleAgents[k] || ''}
                          onChange={(v) => setCModuleAgents((prev) => ({ ...prev, [k]: v }))}
                          placeholder="Без агента"
                          options={[{ value: '', label: 'Без агента' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
                        />
                      </div>
                      <div>
                        <div className="mb-1 text-xs text-white/50">Пресет настроек</div>
                        {presets.length ? (
                          <Select
                            value={cModulePresetId[k] || ''}
                            onChange={(v) => {
                              setCModulePresetId((prev) => ({ ...prev, [k]: v }))
                              setCModuleSettings((prev) => {
                                const next = { ...prev }
                                const s = v ? (presets.find((p) => p.id === v)?.settings as unknown as Record<string, unknown>) : undefined
                                if (s) next[k] = s
                                else delete next[k]
                                return next
                              })
                            }}
                            options={[
                              { value: '', label: 'По умолчанию (настройки модуля)' },
                              ...presets.map((p) => ({ value: p.id, label: p.name })),
                            ]}
                          />
                        ) : (
                          <div className="pt-1.5 text-xs text-white/40">Пресетов нет — запустится с настройками модуля по умолчанию.</div>
                        )}
                      </div>
                    </div>

                    {/* Рассылка: получатели — это номера/юзернеймы, а не каналы. Задаём их
                        отдельно (юзернеймы — своей строкой): общие целевые каналы кампании сюда
                        не годятся, писать в ЛС каналу нельзя. Модуль сам разберёт номер vs юзернейм. */}
                    {k === MAILING_KEY && (
                      <div className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-2">
                        <div>
                          <div className="mb-1 text-xs text-white/50">Получатели — номера <span className="text-white/30">(по одному на строку)</span></div>
                          <textarea
                            className="input min-h-[64px] font-mono text-sm"
                            value={cMailNumbers}
                            onChange={(e) => setCMailNumbers(e.target.value)}
                            placeholder={'+79991234567\n+380671234567'}
                          />
                        </div>
                        <div>
                          <div className="mb-1 text-xs text-white/50">Получатели — юзернеймы <span className="text-white/30">(по одному на строку)</span></div>
                          <textarea
                            className="input min-h-[64px] font-mono text-sm"
                            value={cMailUsernames}
                            onChange={(e) => setCMailUsernames(e.target.value)}
                            placeholder={'@username1\n@username2'}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* §9.0: СВОИ каналы кампании. Раньше их было негде задать: форма каналов не
              показывала, запуск брал их из цели, а рядом на странице жил отдельный
              «запускатор» со своим полем целей — отсюда и ощущение двух разных
              «кампаний» на одном экране (прогон 21–22.07, тест 1.2). */}
          <div>
            <div className="mb-1 text-xs text-white/50">
              Целевые каналы/группы <span className="text-white/30">(по одному на строку; пусто — возьмём каналы цели)</span>
            </div>
            {/* Папки целей: раньше выбрать папку можно было только в разовом запуске, а в форме
                кампании — нет, и большие списки каналов приходилось вставлять руками. */}
            <FolderPicker
              targets={cTargets.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)}
              onLoad={(loaded) => setCTargets((prev) => {
                const have = new Set(prev.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))
                const add = loaded.map((x) => x.trim()).filter(Boolean).filter((x) => !have.has(x) && !have.has(`@${x}`))
                return [...prev.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean), ...add].join('\n')
              })}
            />
            <textarea
              className="input min-h-[72px] font-mono text-sm"
              value={cTargets}
              onChange={(e) => setCTargets(e.target.value)}
              placeholder={'@channel1\nhttps://t.me/group2'}
            />
          </div>

          {/* §9: кампания = основной модуль + опциональный чатинг. Основной модуль приводит
              людей, чатинг ведёт ответивших к цели и сам прощается по выполнению.
              Если основной модуль САМ диалоговый — добавлять к нему чатинг не к чему:
              он и так ведёт переписку, вторая копия дублировала бы ответы. */}
          {!cModules.some((m) => DIALOG_MODULES.has(m)) && (
          <div className="rounded-xl border border-line bg-elevated/40 p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={cChat} onChange={(e) => setCChat(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
              <span>
                <span className="text-sm font-semibold">Добавить чатинг</span>
                <span className="mt-0.5 block text-xs text-white/45">
                  Те, кто ответил на «{moduleTitle(cModule)}», попадают в воронку — ИИ доводит их до цели
                  и прощается, когда целевое действие выполнено.
                </span>
              </span>
            </label>

            {cChat && (
              <div className="mt-3 space-y-3 border-t border-line pt-3">
                <div>
                  <div className="mb-1 text-xs text-white/50">Инструкция ИИ — как вести диалог и к чему вести</div>
                  <textarea
                    className="input min-h-[76px] resize-y"
                    value={cChatGoal}
                    onChange={(e) => setCChatGoal(e.target.value)}
                    placeholder={cGoalId ? `Цель «${goalNameOf(cGoalId)}» уже передаётся ИИ. Здесь — тон и детали: как знакомиться, что отвечать на возражения.` : 'Напр.: дружелюбно познакомиться, выяснить интерес и пригласить в канал.'}
                  />
                  <div className="mt-1 text-xs text-white/35">
                    {cGoalId ? `Цель кампании: ${goalNameOf(cGoalId)} — целевое действие ИИ берёт из неё.` : 'Без цели кампании лиды не создаются — выберите цель выше.'}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-white/50">Кому отвечаем</div>
                    <Select value={cChatScope} onChange={(v) => setCChatScope(v as 'unread' | 'all')} options={[
                      { value: 'unread', label: 'Только новые сообщения' },
                      { value: 'all', label: 'Все диалоги, где ждут ответа' },
                    ]} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-white/50">Сколько сообщений пишем одному лиду</div>
                    <Select value={cChatLimitMode} onChange={(v) => setCChatLimitMode(v as 'untilTarget' | 'count')} options={[
                      { value: 'untilTarget', label: 'Пока не выполнит целевое действие' },
                      { value: 'count', label: 'Фиксированное число' },
                    ]} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {cChatLimitMode === 'count' && (
                    <div>
                      <div className="mb-1 text-xs text-white/50">Максимум ответов на лида</div>
                      <input type="number" min={1} className="input" value={cChatMaxReplies}
                        onChange={(e) => setCChatMaxReplies(Math.max(1, Number(e.target.value) || 1))} />
                    </div>
                  )}
                  <div>
                    <div className="mb-1 text-xs text-white/50">Активных диалогов на аккаунт <span className="text-white/30">(0 — без лимита)</span></div>
                    <input type="number" min={0} className="input" value={cChatMaxDialogs}
                      onChange={(e) => setCChatMaxDialogs(Math.max(0, Number(e.target.value) || 0))} />
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          <div>
            <div className="mb-1 text-xs text-white/50">Аккаунты — {freeForCampaign.length} свободных (не закреплены другой кампанией)</div>
            <div className="mb-2 inline-flex rounded-lg border border-line bg-elevated p-0.5 text-xs">
              {['Числом из пула', 'Выбрать вручную', 'Группой (папкой)'].map((l, i) => (
                <button key={l} type="button" onClick={() => setPickMode(i)} className={`rounded px-3 py-1.5 font-semibold ${pickMode === i ? 'bg-spark-gradient text-[#04150c]' : 'text-muted'}`}>{l}</button>
              ))}
            </div>
            {pickMode === 0 ? (
              <div className="flex items-center gap-2">
                <input type="number" min={0} max={freeForCampaign.length} value={takeN} onChange={(e) => setTakeN(Math.max(0, Number(e.target.value) || 0))} className="input h-9 w-28" />
                <span className="text-xs text-white/50">из {freeForCampaign.length} свободных</span>
              </div>
            ) : (
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-2.5">
                {freeForCampaign.length === 0 && <span className="text-xs text-white/40">Свободных аккаунтов нет — все закреплены другими кампаниями</span>}
                {freeForCampaign.map((a) => {
                  const on = cAccounts.includes(a.id)
                  return (
                    <button key={a.id} type="button"
                      onClick={() => setCAccounts((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
                      className={`rounded-lg border px-2 py-1 text-xs ${on ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line text-white/60'}`}>
                      {a.name || a.phone || a.id.slice(-6)}
                    </button>
                  )
                })}
              </div>
            )}
            {pickMode === 2 && (
              <div className="rounded-xl border border-line bg-elevated/40 p-2.5">
                {groups.length === 0 ? (
                  <p className="text-xs text-white/40">Групп аккаунтов пока нет. Выберите аккаунты вручную и сохраните их как группу — она появится здесь и в «Ролях и доступах».</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {groups.map((g) => {
                      const on = pickedGroups.includes(g.id)
                      const free = g.accountIds.filter((id) => freeForCampaign.some((a) => a.id === id)).length
                      return (
                        <button key={g.id} type="button"
                          onClick={() => setPickedGroups((prev) => (on ? prev.filter((x) => x !== g.id) : [...prev, g.id]))}
                          className={`rounded-lg border px-2 py-1 text-xs ${on ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line text-white/60'}`}>
                          {g.name} <span className="text-white/40">· {free}/{realCount(g.accountIds)} свободны</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {pickMode === 1 && cAccounts.length > 0 && (
              <button type="button" onClick={() => void saveSelectionAsGroup()} className="btn-ghost mt-2 h-8 text-xs">
                + Сохранить выбранные как группу
              </button>
            )}
            <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
              <input type="checkbox" checked={cPinned} onChange={(e) => setCPinned(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
              Закрепить аккаунты за кампанией (выйдут из общего пула). Без галочки — «использовать без лока».
            </label>
          </div>

          {/* Оркестрация: срок этапа и настойчивость в диалоге. Раньше дедлайн жил
              в цели, а дожим — в агенте. Оба переехали сюда (24.07): цель — счётчик,
              агент — манера речи, а решения о ходе работы принимает кампания. */}
          <div className="rounded-xl border border-line bg-elevated/40 p-3">
            <div className="mb-2 text-sm font-semibold text-fg">Оркестрация</div>

            <label className="mb-1 block text-xs text-white/50">
              Дедлайн этапа <span className="text-white/30">(необязательно)</span>
            </label>
            <input type="date" value={cDeadline} onChange={(e) => setCDeadline(e.target.value)} className="input h-9 max-w-[220px]" />
            <p className="mt-1 text-xs text-white/40">
              После этой даты кампания не запускается, а уже идущие задачи останавливаются.
            </p>

            <label className="mt-3 flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-1 h-4 w-4 rounded border-line accent-spark-500" checked={cFollowUp} onChange={(e) => setCFollowUp(e.target.checked)} />
              <span>
                <span className="text-sm font-semibold text-fg">Дожимать, если написал сам после закрытия</span>
                <span className="mt-0.5 block text-xs text-white/45">
                  Диалог закрыт (цель достигнута или отказ), но человек написал сам — это входящий
                  интерес, а не наша навязчивость. Отвечаем, но не больше указанного числа сообщений.
                </span>
              </span>
            </label>
            {cFollowUp && (
              <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr]">
                <div>
                  <label className="mb-1 block text-xs text-white/50">Максимум сообщений</label>
                  <input
                    type="number" min={1} max={FOLLOW_UP_MAX} className="input"
                    value={cFollowUpLimit}
                    onChange={(e) => setCFollowUpLimit(Math.min(FOLLOW_UP_MAX, Math.max(1, Number(e.target.value) || FOLLOW_UP_DEFAULT)))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-white/50">Что делать в дожиме <span className="text-white/30">(необязательно)</span></label>
                  <input className="input" value={cFollowUpText} onChange={(e) => setCFollowUpText(e.target.value)} placeholder="Напр. узнать, что не подошло" />
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button onClick={() => setFormOpen(false)} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void saveCampaign()} disabled={cSaving} className="btn-primary h-10">{cSaving ? 'Сохранение…' : editingCampaign ? 'Сохранить' : 'Создать кампанию'}</button>
          </div>
        </Card>
      </div>
    )
  }

  // §9.0: РАЗОВЫЙ запуск — отдельный экран, а не блок под списком.
  //
  // Раньше он висел прямо на странице, и получалось две разные вещи с одним названием:
  // сущность «Кампания» (cmp_) сверху и безымянный запуск (camp_), который генерил свой
  // id и ни к какой кампании не привязывался. Тестировщик на прогоне 21–22.07 не смог
  // понять, откуда запускать (тест 1.2). Теперь страница показывает ТОЛЬКО кампании,
  // а всё остальное открывается кнопкой — как в «Агентах» и «Задачах».
  const mainScreen = (
    <div>
      <PageHeader
        title="Кампании"
        subtitle="Кампания = цель + модули + свои каналы и аккаунты. Запускается повторно и помнит настройки."
        icon={<Rocket size={22} />}
        actions={(
          <div className="flex items-center gap-2">
            <HelpButton topic="campaign" className="h-10 w-10" />
            <button onClick={() => setOneOffOpen(true)} className="btn-ghost h-10" title="Запустить модули один раз, не заводя кампанию">
              <Zap size={15} /> Разовый запуск
            </button>
            <button onClick={openNewCampaign} className="btn-primary h-10"><Plus size={16} /> Создать кампанию</button>
          </div>
        )}
      />

      {/* §5: список кампаний — единственное, что показывает страница. */}
      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Rocket size={26} />}
          title="Кампаний пока нет"
          desc="Кампания — это этап работы к цели: несколько модулей, свои каналы и свой пул аккаунтов. Настраивается один раз и запускается сколько угодно."
          action={<button onClick={openNewCampaign} className="btn-primary h-9"><Plus size={15} /> Создать кампанию</button>}
        />
      ) : (
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            <Rocket size={15} className="text-spark-400" /> Кампании ({campaigns.length})
          </div>
          <div className="flex flex-col gap-2">
            {campaigns.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-3">
                <Badge tone={c.status === 'active' ? 'spark' : c.status === 'paused' ? 'amber' : c.status === 'done' ? 'muted' : 'iris'}>
                  {{ draft: 'Черновик', active: 'Активна', paused: 'Пауза', done: 'Завершена' }[c.status]}
                </Badge>
                <span className="font-semibold text-white">{c.name}</span>
                <span className="text-xs text-white/50">{moduleTitle(c.moduleKey)}</span>
                {c.chat?.enabled && <Badge tone="iris">+ чатинг</Badge>}
                {c.goalId && <span className="text-xs text-iris-300"><TargetIcon size={11} className="mb-0.5 inline" /> {goalNameOf(c.goalId)}</span>}
                <span className="inline-flex items-center gap-1 text-xs text-white/50" title={c.pinned ? 'Аккаунты закреплены — вышли из общего пула' : 'Аккаунты используются без лока'}>
                  {c.pinned ? <Lock size={11} className="text-amber-300" /> : <LockOpen size={11} />} {realCount(c.accountIds)} акк.
                </span>
                <div className="ml-auto flex gap-1">
                  <button onClick={() => void launchSaved(c)} className="btn-primary h-8 px-3 text-xs" aria-label="Запустить кампанию"><Rocket size={13} /> Запустить</button>
                  <button onClick={() => openEditCampaign(c)} className="btn-icon h-8 w-8" aria-label="Изменить"><Pencil size={14} /></button>
                  <button onClick={() => void removeCampaign(c)} className="btn-icon-danger h-8 w-8" aria-label="Удалить кампанию" title="Удалить кампанию"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {schedules.length > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Запланированные кампании</div>
          <div className="flex flex-col gap-2">
            {schedules.map((s) => (
              <div key={s.id} className={`flex flex-wrap items-center gap-2 rounded-xl border p-2.5 ${s.enabled ? 'border-line bg-elevated/40' : 'border-line/60 bg-elevated/20 opacity-60'}`}>
                <Badge tone={s.enabled ? 'spark' : 'muted'}>{s.enabled ? 'вкл' : 'выкл'}</Badge>
                <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                <Badge tone="iris">{s.repeat === 'daily' ? 'ежедневно' : 'один раз'}</Badge>
                <span className="text-xs text-white/50"><Clock size={11} className="mb-0.5 mr-0.5 inline" />{new Date(s.runAt).toLocaleString()}</span>
                {s.lastRunAt && <span className="text-xs text-white/40">· последний: {new Date(s.lastRunAt).toLocaleString()}{s.lastResult?.error ? ` (${s.lastResult.error})` : s.lastResult ? ` (задач: ${s.lastResult.tasks})` : ''}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => void toggleSchedule(s)} className="btn-icon h-8 w-8" aria-label="Вкл/выкл"><Power size={14} className={s.enabled ? 'text-spark-400' : 'text-white/40'} /></button>
                  <button onClick={() => void removeSchedule(s)} className="btn-icon-danger h-8 w-8" aria-label="Удалить расписание" title="Удалить расписание"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )

  const oneOffBody = (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-1 text-xs text-white/50">Цель кампании</div>
          <Select value={goalId} onChange={setGoalId} placeholder="Без цели" options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />

          <div className="mb-1 mt-4 text-xs text-white/50">Модули (аккаунты поделятся между ними)</div>
          <div className="flex flex-col gap-1.5">
            {CAMPAIGN_MODULES.map((k) => (
              <button key={k} onClick={() => toggle(k)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${mods.has(k) ? 'border-spark-500/40 bg-spark-500/10 text-white' : 'border-white/10 text-white/70'}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${mods.has(k) ? 'border-spark-500 bg-spark-500 text-black' : 'border-white/30'}`}>{mods.has(k) && <Check size={11} />}</span>
                {moduleTitle(k)}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-white/50">Целевые каналы/группы (по одному на строку)</span>
            <DedupeButton value={targetsText} onChange={setTargetsText} mode="handle" className="btn-soft ml-auto h-7 px-2 text-xs disabled:opacity-40" />
          </div>
          <textarea className="input min-h-[88px]" value={targetsText} onChange={(e) => setTargetsText(e.target.value)} placeholder={'@channel1\nhttps://t.me/group2'} />
          {/* §3.7: объединение источников — цели можно загрузить из сохранённых папок */}
          <div className="mt-2">
            <FolderPicker
              targets={targets}
              onLoad={(t) => setPicked((prev) => {
                const next = new Set(prev)
                t.forEach((x) => { const v = x.trim(); if (v) next.add(v.startsWith('@') || v.includes('t.me') ? v : `@${v}`) })
                return next
              })}
            />
          </div>
          {channels.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-xs text-white/50">Или выбрать из базы каналов ({picked.size} выбрано)</div>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-lg border border-white/10 p-2">
                {channels.filter((c) => c.username).map((c) => {
                  const u = `@${c.username}`
                  const on = picked.has(u)
                  return (
                    <button key={c.id} onClick={() => pickChan(u)} className={`rounded px-2 py-0.5 text-xs ${on ? 'bg-spark-500 text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>
                      {u}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
            <span>Свободных аккаунтов: <b className="text-white">{freeIds.length}</b></span>
            <span>Модулей: <b className="text-white">{mods.size}</b></span>
            <span>≈ на модуль: <b className="text-white">{perModule}</b></span>
            <span>Целей-каналов: <b className="text-white">{targets.length}</b></span>
          </div>
          <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary mt-3 h-10 w-full">
            <Rocket size={16} /> {launching ? 'Запуск…' : 'Запустить разово'}
          </button>
          {freeIds.length === 0 && <div className="mt-2 text-xs text-amber-300">Нет свободных аккаунтов (все заняты или в прогреве).</div>}

          {/* §3.9: расписание — запустить кампанию по времени + вкл/выкл + повтор */}
          <div className="mt-3 rounded-xl border border-line bg-elevated/40 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><CalendarClock size={15} className="text-iris-300" /> Запланировать</div>
            <div className="flex flex-wrap items-center gap-2">
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className="input h-9 flex-1" />
              <Select value={repeat} onChange={(v) => setRepeat(v as 'none' | 'daily')} className="w-36" options={[{ value: 'none', label: 'Один раз' }, { value: 'daily', label: 'Каждый день' }]} />
              <button onClick={() => void schedule()} disabled={scheduling || !runAt || !mods.size || !targets.length} className="btn-iris h-9 text-sm disabled:opacity-40"><Clock size={14} /> {scheduling ? '…' : 'В расписание'}</button>
            </div>
          </div>
        </Card>
      </div>

      {result && (
        <Card className="mt-4 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-white/70">
            Кампания <span className="font-mono text-xs text-white/40">{result.campaignId}</span>
            <button onClick={() => nav('/panel/tasks')} className="btn-ghost ml-auto h-8 text-xs">Открыть «Задачи» →</button>
          </div>
          <div className="flex flex-col gap-1">
            {result.tasks.map((t) => (
              <div key={t.taskId} className="flex items-center gap-2 rounded bg-white/5 px-3 py-1.5 text-sm">
                <Badge tone="spark">запущено</Badge>
                <span className="text-white">{moduleTitle(t.moduleKey)}</span>
                <span className="text-xs text-white/40">{t.accounts} акк.</span>
              </div>
            ))}
            {result.skipped.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded bg-white/5 px-3 py-1.5 text-sm">
                <Badge tone="amber">пропущено</Badge>
                <span className="text-white/70">{moduleTitle(s.moduleKey)}</span>
                <span className="text-xs text-white/40">— {s.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  )

  if (oneOffOpen) {
    return (
      <div>
        <button onClick={() => setOneOffOpen(false)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к кампаниям</button>
        <PageHeader
          title="Разовый запуск"
          subtitle="Без сохранения кампании: цель + сразу несколько модулей на общем пуле. Задача не привяжется к кампании — для повторяемой работы заведите кампанию."
          icon={<Rocket size={22} />}
        />
        {oneOffBody}
      </div>
    )
  }

  return mainScreen
}
