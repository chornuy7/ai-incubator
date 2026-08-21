import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Play, Sparkles, Hash, Clock, Users, MessageSquareText,
  Heart, Eye, Shield, MessageCircle, Database, Trophy, Link2, Plus, Terminal, ArrowUpRight, Lock, LockOpen, Flame,
} from 'lucide-react'
import { MODULES, isCombatModule, combatConfirmText, type ModuleConfig } from '@/shared/config/modules'
import { activeAccounts, useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { can } from '@/shared/lib/access'
import { cn } from '@/shared/lib/utils'
import { equalize, equalizeUnlocked, redistribute, percentSum } from '@/shared/lib/percentDistribution'
import { ToggleGroup, Segmented, EmptyState, Badge } from '@/shared/ui'
import { isGoalExpired } from '@/api/goalsApi'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'
import { createAutomationRule } from '@/api/automationApi'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { useModuleTask } from './shared/useModuleTask'
import {
  SectionCard, NumberField,
  ProtectionTimings, TargetsEditor, LaunchPanel, PromptCards, loadPromptBodies, AiGenerationNotice,
  FolderPicker, BlacklistEditor, GlobalPromptEditor, TimingSection, SaveToFolderModal, TaskStartedModal, SavePresetModal,
  LaunchSteps, markCurrentStep, type LaunchStep,
} from './shared'
import type { ModuleTaskSettings } from '@/api/modulesApi'
import { confirmDialog } from '@/shared/lib/dialog'
import { LaunchCost } from './shared/LaunchCost'
import { PRESET_MUL } from './shared/TimingSection'
/**
 * Потолок вероятности по уровню защиты — зеркало effectiveProbability из
 * server/lib/protection.js. Значение выше выставить можно, но сервер его срежет,
 * поэтому форма обязана сказать об этом ДО запуска.
 */
const PROTECTION_CAP = [25, 45, 100]
import { PresetBar } from './shared/PresetBar'

const DEFAULT_DELAYS = {
  comment: [30, 120] as [number, number],
  action: [30, 120] as [number, number],
  join: [84, 156] as [number, number],
  floodWait: 120,
  floodQuarantine: 3,
}

const DURATION_MIN_BY_PROTECTION_LEVEL = [60, 45, 30]

// 3 уровня прогрева (решение 14.07): длительность и «естественность» темпа.
const WARM_LEVELS = ['Быстрый · 2 дня', 'Нормальный · 3–7 дней', 'Стандартный · 7–14 дней']

// §3.5: расчётное min/avg/max время вместо абстрактного «интервала».
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)}с`
  if (sec < 3600) return `${Math.round(sec / 60)} мин`
  return `${(sec / 3600).toFixed(1)} ч`
}

/** Чего именно лимит — по типу модуля, чтобы в панели было «Лимит комментариев», а не голое «Лимит». */
function limitNoun(moduleKey: string, cfg: ModuleConfig): string {
  const byKey: Record<string, string> = {
    'neuro-commenting': 'комментариев',
    'neuro-chatting': 'сообщений',
    'neuro-dialogs': 'сообщений',
    'mass-react': 'реакций',
    'mass-looking': 'просмотров',
    warming: 'действий',
    ggr: 'проверок',
    'parsing-users': 'участников',
    'parsing-messages': 'сообщений',
    'parsing-comments': 'комментариев',
  }
  if (byKey[moduleKey]) return byKey[moduleKey]
  if (cfg.reactionSettings) return 'реакций'
  return 'действий'
}

export function LiveModule({ moduleKey }: { moduleKey: string }) {
  const cfg = MODULES[moduleKey]
  if (!cfg) return null
  return <LiveModuleInner cfg={cfg} moduleKey={moduleKey} />
}

function LiveModuleInner({ cfg, moduleKey }: { cfg: ModuleConfig; moduleKey: string }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const { task, running, starting, start, stop, savePreset, deletePreset, editPreset, presets, pushToast, justStarted, dismissJustStarted } = useModuleTask(moduleKey)

  // R6: гейтинг блоков внутри модуля по правам роли. Демо/админ — всё видно.
  // run — запуск/аккаунты; settings — настройки/тайминги/защита; targets — цели/каналы;
  // templates — промпты/эмодзи; results/logs — просмотр результатов/логов.
  const sessionUser = useSession((s) => s.user)
  const showBlock = (bk: string) => !sessionUser || sessionUser.isAdmin || can(sessionUser.permissions, false, 'block', `${moduleKey}:${bk}`)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  // «Мониторинг новых» стоит первым в списке и выбран по умолчанию (так просил
  // владелец) — бот следит за каналом и комментирует каждый новый пост.
  const [toggles, setToggles] = useState<Record<number, number>>(
    moduleKey === 'neuro-commenting' ? { 0: 0 } : {},
  )
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [notifyStatus, setNotifyStatus] = useState(true) // MR-134: уведомлять о статусе этой задачи
  const [probability, setProbability] = useState(cfg.probabilitySlider?.value ?? cfg.reactionSettings?.probability.value ?? 30)
  const [maxActions, setMaxActions] = useState(cfg.workModeFields?.maxValue ?? cfg.reactionSettings?.max.value ?? 100)
  const [minActions, setMinActions] = useState(0)
  const [maxPerAcc, setMaxPerAcc] = useState(10)
  const [minPerAcc, setMinPerAcc] = useState(0)
  const [minWords, setMinWords] = useState(0)
  const [durationMinutes, setDurationMinutes] = useState(cfg.reactionSettings?.duration.value ?? 60)
  // Сколько последних постов канала рассматриваем: массовые реакции («Существующие
  // посты») и нейрокомментинг («Последние N»).
  const [lastPostsCount, setLastPostsCount] = useState(3)
  // Брать ли ОДИН случайный пост из подходящих (иначе — все подходящие за заход).
  const [pickOne, setPickOne] = useState(true)
  // Есть ли у модуля СВОИ параметры в карточке «Параметры и лимиты». У прогрева,
  // масслукинга и прочих их нет: темп задаёт «Уровень прогрева» / тайминги, и после
  // переноса карточки наверх (19.08) она оказалась пустой — выглядело как «пропала».
  // Там, где параметров нет, карточкой оформляется панель запуска внизу, как было.
  const [srcTab, setSrcTab] = useState(0)
  const [input, setInput] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [postInput, setPostInput] = useState('')
  const [postUrls, setPostUrls] = useState<string[]>([])
  const [keywords, setKeywords] = useState((cfg.defaultKeywords || []).join(', '))
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() => loadPromptBodies(moduleKey, cfg.messagePrompts ?? []))
  const [delayPreset, setDelayPreset] = useState(1)
  const [delays, setDelays] = useState(DEFAULT_DELAYS)
  const [goalId] = useState('')
  // §0: задача запускается ПОД КАМПАНИЕЙ; цель наследуется из кампании.
  // Пока кампаний нет — остаётся прямой выбор цели (мягкая миграция, ничего не ломаем).
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignId] = useState('')
  const [warmLevel, setWarmLevel] = useState(1)
  const [postWindow, setPostWindow] = useState(10) // §3.5: сколько последних постов обрабатывать
  const [stopWordsText, setStopWordsText] = useState('') // §3.5: пропускать посты с этими словами
  const [analyzeImages, setAnalyzeImages] = useState(false) // §10.5: анализ фото в посте vision-моделью
  const [typeWeights, setTypeWeights] = useState<number[]>(() => equalize(cfg.messagePrompts?.length || 0))
  // §13 (MR-61): замки — закреплённое значение не трогается при перераспределении остатка.
  const [lockedWeights, setLockedWeights] = useState<boolean[]>([])
  // §13 (уточнение заказчика): «тронутые» — поля, куда пользователь ВВЁЛ значение вручную.
  // Их сохраняем при перераспределении ДАЖЕ без замка; остаток делят только НЕтронутые.
  const [touchedWeights, setTouchedWeights] = useState<boolean[]>([])
  const weightSum = percentSum(typeWeights)
  // §13 (MR-61): «поровну» выравнивает только НЕзакреплённые и сбрасывает ручной ввод.
  const balanceTypeWeights = () => {
    const n = cfg.messagePrompts?.length ?? 0
    if (!n) return
    setTypeWeights((w) => equalizeUnlocked(w.length === n ? w : equalize(n), lockedWeights))
    setTouchedWeights([])
  }
  const toggleWeightLock = (i: number) => setLockedWeights((l) => { const n = [...l]; n[i] = !n[i]; return n })
  // Кампании этого модуля (кампания настраивает ровно один модуль — §0).
  useEffect(() => {
    void fetchCampaigns({ moduleKey }).then(({ campaigns: cs }) => setCampaigns(cs.filter((c) => c.status !== 'done'))).catch(() => {})
  }, [moduleKey])
  // §3.5: главное поле — «на 1 аккаунт»; общий лимит считается авто = на-аккаунт × число выбранных.
  const accCount = selected.size || 1
  useEffect(() => {
    setMaxActions(maxPerAcc * accCount)
    setMinActions(minPerAcc * accCount)
  }, [maxPerAcc, minPerAcc, accCount])
  const [palette, setPalette] = useState<Set<string>>(new Set(['👍', '❤️', '🔥']))
  const [folderSave, setFolderSave] = useState<string[] | null>(null)
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  // §6: настройка автоматизации прямо в модуле — запуск по времени, одно-/многоразово.
  const [schedOpen, setSchedOpen] = useState(false)
  const [schedMode, setSchedMode] = useState(0) // 0 — однократно, 1 — ежедневно, 2 — интервал
  const [schedAt, setSchedAt] = useState(() => {
    const d = new Date(Date.now() + 3600_000)
    d.setSeconds(0, 0)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })
  const [schedTime, setSchedTime] = useState('12:00')
  const [schedEvery, setSchedEvery] = useState(60)
  const [schedSaving, setSchedSaving] = useState(false)
  const [lookModeIdx, setLookModeIdx] = useState(0)
  const [lookPostsCount, setLookPostsCount] = useState(cfg.lookPostsDefault ?? 3)

  const g = (i: number) => toggles[i] ?? 0
  const setTg = (i: number, v: number) => setToggles((t) => ({ ...t, [i]: v }))
  const needsTargets = Boolean(
    cfg.richLayout ||
    cfg.lookingLayout ||
    ['parsing-users', 'parsing-messages', 'parsing-comments'].includes(moduleKey),
  )
  const isParser = cfg.parserLayout || cfg.participantsLayout
  const isGgr = cfg.ggrLayout
  // Есть ли ЧТО показать в карточке «Параметры и лимиты»: у нейрокомментинга это выбор
  // постов и стоп-слова, у остальных боевых модулей — объём задачи (режим работы, сколько
  // сделает аккаунт). У прогрева и парсеров ни того, ни другого: там карточка оформляет
  // панель запуска, как было до переноса 19.08.
  const hasLimits = !isParser && !isGgr && !cfg.warmingLayout && (cfg.aiProtection || cfg.richLayout || cfg.lookingLayout)
  const hasParamsCard = moduleKey === 'neuro-commenting' || hasLimits

  const maybeSaveToFolder = (list: string[]) => {
    // (5) Предложить сохранить добавленный список в папку через красивый модал.
    if (!list.length) return
    setFolderSave(list)
  }

  const addTargets = () => {
    const parsed = input.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split('/')[0]).filter(Boolean)
    if (!parsed.length) return pushToast({ type: 'error', title: 'Нет целей' })
    const next = [...new Set([...parsed, ...targets])]
    setTargets(next)
    setInput('')
    pushToast({ type: 'success', title: 'Добавлено', desc: `${parsed.length}` })
    maybeSaveToFolder(next)
  }

  const addPostUrls = () => {
    const parsed = postInput.split('\n').map((s) => s.trim()).filter((s) => /t\.me\/(c\/\d+\/\d+|[a-zA-Z0-9_]+\/\d+)/i.test(s))
    if (!parsed.length) return pushToast({ type: 'error', title: 'Нет ссылок', desc: 'Формат: t.me/channel/123 или t.me/c/1234567890/42' })
    const next = [...new Set([...parsed, ...postUrls])]
    setPostUrls(next)
    setPostInput('')
    pushToast({ type: 'success', title: 'Посты добавлены', desc: `${parsed.length}` })
    maybeSaveToFolder(next)
  }

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds: [...selected],
    targets,
    channels: targets,
    keywords: keywords.split(/[\n;]+/).map((k) => k.trim()).filter(Boolean),
    // Один выбор в форме раскладывается в два поля воркера:
    //   0 «Мониторинг новых»   → любые посты (2) + мониторинг (4): планка на канал
    //   1 «Только последний»   → любые посты (2) + оставить самый свежий (0)
    //   2 «Последние N»        → любые посты (2) + без доп. отсева (2); N — это postWindow
    //   3 «По ключевым словам» → фильтр по словам (1) в тех же N постах (2)
    commentMode: cfg.toggleGroups ? (g(0) === 3 ? 1 : 2) : g(0),
    pickOne,
    workMode: g(1),
    postFilter: cfg.toggleGroups ? [4, 0, 2, 2][g(0)] ?? 4 : g(2),
    probability,
    maxActions,
    maxComments: maxActions,
    maxPerAccount: maxPerAcc,
    minActions,
    minComments: minActions,
    minPerAccount: minPerAcc,
    minWords,
    durationMinutes: g(1) === 1 ? durationMinutes : undefined,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    notifyOnStatus: notifyStatus,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    delayPreset,
    emojis: [...palette],
    postUrls,
    limit: maxActions,
    delays,
    // §0: под кампанией цель наследуется от неё; без кампании — прямой выбор цели.
    ...(campaignId ? { campaignId } : {}),
    ...((campaignId ? campaigns.find((c) => c.id === campaignId)?.goalId : goalId) ? { goalId: (campaignId ? campaigns.find((c) => c.id === campaignId)?.goalId : goalId) as string } : {}),
    ...(cfg.warmingLayout ? { warmLevel } : {}),
    // Массовые реакции: режим и глубина. Отдельным полем, а не общим commentMode —
    // воркер читает именно reactMode, и дескриптор MCP описывает его.
    ...(cfg.reactionSettings ? { reactMode: g(0), lastPostsCount } : {}),
    ...(moduleKey === 'neuro-commenting' ? { postWindow, stopWords: stopWordsText.split(/[\n;]+/).map((w) => w.trim()).filter(Boolean), analyzeImages } : {}),
    // Распределение уходит в задачу у любого модуля с промптами — воркеры выбирают тип
    // взвешенным броском на каждое действие (см. pickPrompt в workers.js).
    ...((cfg.messagePrompts?.length ?? 0) > 0 && weightSum > 0 ? { typeWeights } : {}),
    ...(cfg.lookingLayout ? {
      lookMode: cfg.lookModeOptions?.[lookModeIdx]?.value ?? 'stories',
      lookPostsCount,
    } : {}),
  }), [selected, targets, postUrls, toggles, probability, maxActions, minActions, maxPerAcc, minPerAcc, minWords, durationMinutes, aiProtect, protLevel, notifyStatus, activePrompt, promptBodies, delayPreset, palette, delays, keywords, isGgr, accounts, cfg, lookModeIdx, lookPostsCount, goalId, campaignId, campaigns, warmLevel, postWindow, stopWordsText, analyzeImages, moduleKey, typeWeights, weightSum])

  const hasPostTargets = postUrls.length > 0
  // Многомодульность (20.08): аккаунт МОЖНО брать, пока он работает в другом модуле.
  // Мешают ровно два случая, и оба — зеркало серверного правила (accountLocks.js):
  //   1) вторая задача ТОГО ЖЕ модуля — она дублировала бы работу;
  //   2) прогрев в любую сторону — греющийся профиль ещё не боец, а бойца нельзя греть.
  // Без второго пункта форма пускала выбор, а сервер отказывал уже на «Запустить» —
  // оператор узнавал о запрете в последний момент и не понимал, чей аккаунт виноват.
  const busySelectedCount = useMemo(
    () => [...selected].filter((id) => accounts.some((a) => {
      if (a.id !== id || !a.busyIn) return false
      const mods = a.busyIn.modules ?? [{ moduleKey: a.busyIn.moduleKey }]
      return mods.some((m) => m.moduleKey === moduleKey || m.moduleKey === 'warming' || moduleKey === 'warming')
    })).length,
    [selected, accounts, moduleKey],
  )
  // #5: сумма процентов типов не должна превышать 100 — иначе запуск блокируется.
  const typesOver100 = moduleKey === 'neuro-commenting' && weightSum > 100
  // Кампания с истёкшим дедлайном «останавливает работу» — не даём запуск
  // (зеркало 409 бэкенда). Дедлайн переехал из цели в кампанию (24.07): срок —
  // свойство этапа работы, цель «200 переходов» сама по себе бессрочна.
  const goalExpired = useMemo(() => {
    const c = campaignId ? campaigns.find((x) => x.id === campaignId) : null
    return c ? isGoalExpired(c) : false
  }, [campaignId, campaigns])
  const canStart = (isGgr
    ? selected.size > 0
    : selected.size > 0 && busySelectedCount === 0 && (!needsTargets || targets.length > 0 || hasPostTargets))
    && !typesOver100 && !goalExpired
  // §11 (MR-53): перечисляем ВСЕ незаполненные обязательные поля, а не первое попавшееся —
  // чтобы оператор сразу видел всё, что мешает запуску, а не открывал по одному.
  const missingRequired = useMemo(() => {
    const m: string[] = []
    if (isGgr) { if (!selected.size) m.push('выберите аккаунты для проверки'); return m }
    if (!selected.size) m.push('выберите аккаунты')
    else if (busySelectedCount) m.push(moduleKey === 'warming'
      ? `${busySelectedCount} аккаунт(а) заняты работой — прогрев берёт только свободные профили`
      : `${busySelectedCount} аккаунт(а) заняты несовместимой задачей (тот же модуль или прогрев) — остановите её или выберите другие`)
    if (needsTargets && !targets.length && !hasPostTargets) m.push('добавьте цель — группу или ссылку на пост')
    return m
  }, [isGgr, selected, busySelectedCount, needsTargets, targets, hasPostTargets])
  const warn = goalExpired
    ? 'Дедлайн выбранной цели истёк — работа по ней остановлена. Продлите дедлайн или уберите цель.'
    : typesOver100
      ? `Сумма типов комментариев ${weightSum}% > 100 — уменьшите (кнопка «= 100%»)`
      : missingRequired.length
        ? `Заполните обязательное: ${missingRequired.join('; ')}`
        : undefined

  // §3.5: предупреждать о математически противоречивых лимитах (макс vs аккаунты vs мин/акк).
  const limitWarn = useMemo(() => {
    if (isGgr || !selected.size) return null
    if (maxActions && maxActions < selected.size) return `Общий лимит ${maxActions} меньше числа аккаунтов (${selected.size}) — часть не получит заданий.`
    if (minPerAcc && maxPerAcc && minPerAcc > maxPerAcc) return `Минимум на аккаунт (${minPerAcc}) больше максимума (${maxPerAcc}).`
    if (minPerAcc && maxActions && minPerAcc * selected.size > maxActions) return `Минимум на аккаунт × аккаунты (${minPerAcc * selected.size}) больше общего лимита (${maxActions}).`
    return null
  }, [isGgr, selected.size, maxActions, minPerAcc, maxPerAcc])

  const durationPeriodMin = Math.min(DURATION_MIN_BY_PROTECTION_LEVEL[protLevel] ?? 0, durationMinutes)

  const handleStart = async () => {
    // #4: запуск боевого модуля = реальные действия в Telegram — подтверждаем.
    if (isCombatModule(moduleKey) && !(await confirmDialog({ title: 'Реальные действия в Telegram', message: combatConfirmText(moduleKey), confirmLabel: 'Начать', tone: 'danger' }))) return
    void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`)
  }
  // §7: шаблон — цветная метка + владелец; открываем модалку вместо простого prompt.
  const handleSave = () => setPresetModalOpen(true)

  // §6: создать правило автоматизации с текущими настройками модуля (не запуская сейчас).
  const createSchedule = async () => {
    if (!canStart) return pushToast({ type: 'error', title: 'Сначала настройте запуск', desc: warn })
    const schedule = schedMode === 0
      ? { type: 'once' as const, at: new Date(schedAt).getTime() }
      : schedMode === 1
        ? { type: 'daily' as const, time: schedTime }
        : { type: 'interval' as const, intervalMinutes: Math.max(1, schedEvery) }
    setSchedSaving(true)
    try {
      await createAutomationRule({
        name: `${cfg.title}${campaignId ? ` · ${campaigns.find((c) => c.id === campaignId)?.name ?? ''}` : ''}`,
        moduleKey,
        campaignId: campaignId || null,
        accountIds: [...selected],
        settings: buildSettings() as unknown as Record<string, unknown>,
        schedule,
      })
      pushToast({ type: 'success', title: 'Правило автоматизации создано', desc: 'Смотрите в разделе «Автоматизация»' })
      setSchedOpen(false)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не создано', desc: e instanceof Error ? e.message : '' })
    } finally { setSchedSaving(false) }
  }

  // Восстанавливает настройки из шаблона в форму (аккаунты не трогаем — они ситуативны).
  const applyPreset = useCallback((s: ModuleTaskSettings) => {
    setToggles({ 0: s.commentMode ?? 0, 1: s.workMode ?? 0, 2: s.postFilter ?? 0 })
    if (s.aiProtection !== undefined) setAiProtect(s.aiProtection)
    if (s.protectionLevel !== undefined) setProtLevel(s.protectionLevel)
    if (s.probability !== undefined) setProbability(s.probability)
    if (s.maxActions !== undefined) setMaxActions(s.maxActions)
    if (s.minActions !== undefined) setMinActions(s.minActions)
    if (s.maxPerAccount !== undefined) setMaxPerAcc(s.maxPerAccount)
    if (s.minPerAccount !== undefined) setMinPerAcc(s.minPerAccount)
    if (s.minWords !== undefined) setMinWords(s.minWords)
    if (s.durationMinutes !== undefined) setDurationMinutes(s.durationMinutes)
    if (s.reactMode !== undefined) setToggles((t) => ({ ...t, 0: s.reactMode as number }))
    if (s.lastPostsCount !== undefined) setLastPostsCount(s.lastPostsCount)
    if (s.pickOne !== undefined) setPickOne(s.pickOne)
    // Обратная раскладка: в шаблоне лежат значения воркера, в форме — один индекс.
    if (cfg.toggleGroups && (s.commentMode !== undefined || s.postFilter !== undefined)) {
      const pos = s.commentMode === 1 ? 3 : (s.postFilter === 4 ? 0 : s.postFilter === 0 ? 1 : 2)
      setToggles((t) => ({ ...t, 0: pos }))
      if (s.commentMode === 0) setPickOne(true)
    }
    if (Array.isArray(s.keywords)) setKeywords(s.keywords.join(', '))
    if (s.promptIndex !== undefined) setActivePrompt(s.promptIndex)
    if (Array.isArray(s.promptOverrides)) setPromptBodies(s.promptOverrides)
    if (s.delayPreset !== undefined) setDelayPreset(s.delayPreset)
    if (s.delays) setDelays((d) => ({ ...d, ...s.delays }))
    if (Array.isArray(s.emojis)) setPalette(new Set(s.emojis))
    if (Array.isArray(s.targets)) setTargets(s.targets)
    if (s.lookMode && cfg.lookModeOptions) {
      const i = cfg.lookModeOptions.findIndex((o) => o.value === s.lookMode)
      if (i >= 0) setLookModeIdx(i)
    }
    if (s.lookPostsCount !== undefined) setLookPostsCount(s.lookPostsCount)
    // Эти семь полей шаблон СОХРАНЯЛ, но не восстанавливал — отсюда и жалоба «сохранил
    // шаблон, а настройки слетают»: применённый шаблон молча оставлял значения текущей
    // формы, и оператор получал не то, что сохранял (ТЗ 19.08 §3).
    if (s.notifyOnStatus !== undefined) setNotifyStatus(s.notifyOnStatus)
    if (Array.isArray(s.postUrls)) setPostUrls(s.postUrls)
    if (s.warmLevel !== undefined) setWarmLevel(s.warmLevel)
    if (s.postWindow !== undefined) setPostWindow(s.postWindow)
    if (Array.isArray(s.stopWords)) setStopWordsText(s.stopWords.join(', '))
    if (s.analyzeImages !== undefined) setAnalyzeImages(s.analyzeImages)
    if (s.typeWeights) setTypeWeights(s.typeWeights)
    pushToast({ type: 'success', title: 'Шаблон применён' })
  }, [cfg.lookModeOptions, cfg.toggleGroups, pushToast])

  const results = task?.results ?? []
  const progressDone = task?.progress.actionsDone ?? task?.progress.commentsSent ?? 0

  const launchStats = useMemo(() => {
    if (isGgr) return [
      { icon: <Trophy size={18} />, color: '#7145ff', label: 'Выбрано', value: String(selected.size), warn: selected.size === 0 },
      { icon: <Database size={18} />, color: '#06b6d4', label: 'Проверено', value: String(results.length) },
      { icon: <Shield size={18} />, color: '#0ec464', label: 'Валидных', value: String(results.filter((r) => r.status === 'valid').length) },
      { icon: <Clock size={18} />, color: '#f59e0b', label: 'Статус', value: task?.status ?? '—' },
    ]
    return [
      { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
      // §12 (MR-59): «цели» перед запуском — с учётом ссылок на посты (mass-react), а не
      // только групп: иначе при выбранных постах счётчик показывал 0, хотя цели есть.
      { icon: <Hash size={18} />, color: '#06b6d4', label: cfg.sourceTabs?.label ?? 'Группы', value: String(targets.length + postUrls.length), warn: needsTargets && !targets.length && !hasPostTargets },
      {
        icon: <Clock size={18} />, color: '#0ec464', label: '≈ время',
        value: (() => {
          const accCount = Math.max(1, selected.size || accounts.length)
          const perAcc = Math.ceil((maxActions || 0) / accCount)
          if (!perAcc) return '—'
          return `${fmtDur(delays.action[0] * perAcc)}–${fmtDur(delays.action[1] * perAcc)}`
        })(),
      },
      { icon: cfg.reactionSettings ? <Heart size={18} /> : <MessageSquareText size={18} />, color: '#f59e0b', label: `Лимит ${limitNoun(moduleKey, cfg)}`, value: String(maxActions) },
    ]
  }, [selected, targets, postUrls, hasPostTargets, delays, maxActions, cfg, isGgr, accounts, results, task, needsTargets])

  // §11 (MR-55): пошаговый roadmap перед запуском — что сделано и что осталось.
  // `anchor` — «связка» с блоком на странице: клик по шагу прокручивает к нему.
  // `optional` — необязательный шаг (тонкая настройка): показываем серым, он не
  // становится «текущим» и не мешает запуску.
  const launchSteps = useMemo(() => {
    const steps: LaunchStep[] = []
    if (cfg.accountPicker) steps.push({ label: 'Аккаунты', done: selected.size > 0, anchor: 'sec-accounts' })
    if (needsTargets && !cfg.warmingLayout) steps.push({ label: cfg.sourceTabs?.label ?? 'Группы', done: targets.length > 0 || hasPostTargets, anchor: 'sec-targets' })
    // Правка 14.08: у прогрева блок «Защита» убран → в степпере вместо «Защита» шаг «Уровень».
    if (cfg.warmingLayout) steps.push({ label: 'Уровень', done: true, optional: true, anchor: 'sec-warm' })
    else steps.push({ label: 'Защита', done: true, optional: true, anchor: 'sec-settings' })
    // MR-136: шаг назван «Параметры» (а не «Запуск») — он ведёт к секции «Параметры и лимиты»,
    // а не к запуску. Раньше клик по «Запуск» кидал на «Параметры» (сбивало), плюс «Запуск»
    // конфликтовал по смыслу с кнопкой «Начать». Запуск — это кнопка «Начать».
    steps.push({ label: 'Параметры', done: true, optional: true, anchor: 'sec-run' })
    return markCurrentStep(steps)
  }, [cfg, selected, needsTargets, targets, hasPostTargets])

  return (
    <div className="space-y-4">
      <TaskStartedModal task={justStarted} moduleTitle={cfg.title} onClose={dismissJustStarted} />
      {/* ТЗ 06.08 §10: выбор шаблона — вверху, до всех настроек (TPL-001). */}
      <PresetBar presets={presets} onApply={applyPreset} onSave={handleSave}
        onEdit={editPreset} onDelete={deletePreset} disabled={running} />
      <SaveToFolderModal open={folderSave !== null} onClose={() => setFolderSave(null)} targets={folderSave ?? []} />
      <SavePresetModal open={presetModalOpen} onClose={() => setPresetModalOpen(false)} onSave={(name, color, owner) => savePreset(name, buildSettings(), color, owner)} />
      {/* MR-149: калькулятор цены за действие теперь в ModuleRunner (для всех модулей). */}
      {cfg.accountPicker && showBlock('run') && (
        <div id="sec-accounts" className="scroll-mt-24">
          <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />
        </div>
      )}

      {/* §3.1 (MR-100): порядок блоков = степпер (Аккаунты → Группы → Защита → Запуск).
          Цели «Группы»/«Посты» идут СРАЗУ после аккаунтов, до блока «Защита» — одинаково во всех модулях.
          §3 (MR-111): в Массовых реакциях цель зависит от режима — «Мониторинг» показывает Группы,
          «Реакции на существующие» — ссылки на посты (ниже). */}
      {showBlock('targets') && (cfg.sourceTabs || needsTargets) && !isGgr && (!cfg.reactionSettings || g(0) === 0) && (
        <div id="sec-targets" className="scroll-mt-24">
        <SectionCard icon={<Hash size={18} />} title={cfg.sourceTabs?.label ?? 'Группы'} badge={String(targets.length)} required={needsTargets && !cfg.postLinks}>
          <FolderPicker targets={targets} onLoad={(t) => setTargets((prev) => [...new Set([...t, ...prev])])} />
          <TargetsEditor
            tabs={cfg.sourceTabs?.tabs}
            tab={srcTab}
            onTab={setSrcTab}
            input={input}
            onInput={setInput}
            targets={targets}
            onAdd={addTargets}
            onClear={() => setTargets([])}
            onRemove={(t) => setTargets((arr) => arr.filter((x) => x !== t))}
            placeholder={cfg.sourceTabs?.placeholder ?? '@username или t.me/...'}
          />
          {/* §12 (UI-004): чёрный список — во ВСЕХ модулях с целями (решение заказчика «да, ко всем»);
              компактным блоком рядом с группами. Принимает и отдельный канал, и целую группу. */}
          <div className="mt-3">
            <BlacklistEditor title={cfg.blacklistSection ?? 'Чёрный список групп и каналов'} compact />
          </div>
        </SectionCard>
        </div>
      )}

      {/* §3 (MR-111): ссылки на посты — только в режиме «Реакции на существующие» (mode 1). */}
      {showBlock('targets') && cfg.postLinks && (!cfg.reactionSettings || g(0) === 1) && (
        <SectionCard icon={<Link2 size={18} />} title={cfg.postLinks.label} badge={String(postUrls.length)}>
          {cfg.postLinks.hint && <p className="mb-3 text-xs text-muted">{cfg.postLinks.hint}</p>}
          <FolderPicker targets={postUrls} onLoad={(t) => setPostUrls((prev) => [...new Set([...t, ...prev])])} />
          <div className="flex gap-2">
            <textarea
              value={postInput}
              onChange={(e) => setPostInput(e.target.value)}
              rows={3}
              className="input resize-none font-mono text-sm"
              placeholder={cfg.postLinks.placeholder}
            />
            <button type="button" onClick={addPostUrls} className="btn-ghost h-auto shrink-0 flex-col px-4">
              <Plus size={16} /> Добавить
            </button>
          </div>
          {postUrls.length > 0 && (
            <div className="mt-4 flex max-h-52 flex-col gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
              {postUrls.map((url) => (
                <span key={url} className="inline-flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-medium text-fg">
                  <span className="truncate font-mono">{url}</span>
                  <button type="button" onClick={() => setPostUrls((arr) => arr.filter((x) => x !== url))} className="shrink-0 text-faint hover:text-rose-300">×</button>
                </span>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* «Параметры и лимиты» — сразу под целями (правка 19.08). Сколько постов
          обрабатывать, какие из них брать и лимиты прогона — продолжение разговора
          про цели. Раньше карточка стояла в самом низу, под защитой и промптами, и
          до неё добирались, уже настроив всё остальное.  */}
      {showBlock('run') && hasParamsCard && (
      <div id="sec-run" className="scroll-mt-24">
      <SectionCard icon={<Play size={18} />} title="Параметры и лимиты">
        {limitWarn && !running && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">⚠ {limitWarn}</div>
        )}
        {showBlock('settings') && moduleKey === 'neuro-commenting' && !running && (
          <div className="mb-3">
            {/* Один вопрос — один блок: ЧТО комментировать и из скольких последних постов. */}
            <ToggleGroup label="Что комментировать" options={cfg.toggleGroups?.[0].options ?? []} value={g(0)} onChange={(v) => setTg(0, v)} />
            {g(0) === 3 && (
              <div className="mt-2 space-y-1">
                <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className="input resize-none text-sm" placeholder="Ключевые слова через ; или с новой строки — крипта; p2p обмен" />
                <p className="text-xs text-white/40">Ищем совпадения среди последних постов (число ниже), а не по всей истории канала.</p>
              </div>
            )}
            {g(0) !== 1 && (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-white/60">
                <input type="checkbox" checked={pickOne} onChange={(e) => setPickOne(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-line accent-spark-500" />
                <span>Брать один случайный из подходящих <span className="text-white/30">(снимите — прокомментирует все подходящие за заход)</span></span>
              </label>
            )}
            {g(0) === 0 && (
              <p className="mt-2 text-xs text-white/40">
                Первый заход в канал только запоминает последний пост и ничего не пишет —
                дальше комментируются посты, вышедшие после этого момента.
              </p>
            )}
            {/* Поле нужно только там, где глубина вообще имеет значение: при «только
                последний» и в мониторинге берётся ровно один пост (правка 19.08). */}
            {(g(0) === 2 || g(0) === 3) && (
              <>
                <div className="mt-3" />
                <NumberField label="Сколько последних постов обрабатывать" value={postWindow} onChange={(n) => setPostWindow(Math.max(1, Math.min(50, n)))} min={1} max={50} suffix="1–50" />
                <div className="mt-1 text-xs text-white/40">Сколько последних постов обрабатывать, не всю историю</div>
              </>
            )}
            <div className="mt-3 mb-1 text-xs text-white/50">Стоп-слова <span className="text-white/30">(пропускать посты с этими словами; несколько — через точку с запятой «;»)</span></div>
            <input value={stopWordsText} onChange={(e) => setStopWordsText(e.target.value)} className="input h-9" placeholder="политика; скам; крипта…" />
            {/* §3.2 (UI-006): «Семантический фильтр к цели» / «Релевантность поста к цели» удалены по ТЗ 06.08. */}
            {/* §10.5: анализ картинок в посте — vision опишет фото, коммент будет по сути
                изображения, а не по «[медиа]». Расход дороже: наценка «картинка ×N» из админки. */}
            <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
              <input type="checkbox" checked={analyzeImages} onChange={(e) => setAnalyzeImages(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
              Анализировать картинки в посте <span className="text-white/30">(vision опишет фото; расход ×N за изображение, нужен OPENAI_API_KEY)</span>
            </label>
          </div>
        )}
        {/* Вероятность — это «сколько из подходящих реально прокомментируем», то есть
            объём, а не темп: место ей в лимитах, рядом с «сколько сделает аккаунт»
            (правка 19.08). */}
        {(cfg.probabilitySlider || cfg.reactionSettings) && !running && (
          <div className="mb-3 rounded-2xl border border-line bg-elevated/40 p-3">
            <div className="mb-1 flex justify-between text-sm text-muted">
              <span>{cfg.probabilitySlider?.label ?? cfg.reactionSettings?.probability.label ?? 'Вероятность'}</span>
              <span className="text-spark-300">{probability}%</span>
            </div>
            <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
            {/* Защита режет вероятность сверху (server/lib/protection.js#effectiveProbability):
                консервативный — не выше 25%, сбалансированный — не выше 45%. Раньше об этом
                не говорилось нигде: оператор ставил 100%, а в логах видел пропуски и считал,
                что настройка не работает (прогон 19.08). */}
            {aiProtect && probability > PROTECTION_CAP[protLevel] && (
              <p className="mt-1.5 text-[11px] text-amber-300">
                Защита ограничивает: фактически будет <b>{PROTECTION_CAP[protLevel]}%</b> —
                {protLevel === 0 ? ' консервативный' : ' сбалансированный'} режим не даёт действовать чаще.
                Выберите «Агрессивный», чтобы работало заданное значение.
              </p>
            )}
          </div>
        )}
        {hasLimits && (
          <TimingSection
            bare
            part="limits"
            workModeOptions={cfg.toggleGroups?.[1]?.options}
            workMode={g(1)}
            onWorkMode={(v) => setTg(1, v)}
            workModeLabel={cfg.toggleGroups?.[1]?.label}
            durationMinutes={durationMinutes}
            onDuration={setDurationMinutes}
            showDurationAlways={!!cfg.reactionSettings}
            durationPeriodHint={`Период работы: ${durationPeriodMin}–${durationMinutes} мин`}
            totalLabel={cfg.reactionSettings?.max.label ?? cfg.workModeFields?.maxLabel ?? 'Всего действий'}
            computedTotal={{ value: maxActions, accounts: accCount }}
            perAccount={{ min: minPerAcc, max: maxPerAcc, onMin: setMinPerAcc, onMax: setMaxPerAcc }}
            minWords={cfg.workModeFields?.minWords ? { value: minWords, onChange: setMinWords } : null}
            delays={delays}
            onDelays={(updater) => setDelays(updater)}
          />
        )}
      </SectionCard>
      </div>
      )}

      {/* Промпты — ВЫШЕ защиты и таймингов (правка 19.08): сначала «что напишет»,
          потом «насколько осторожно». Порядок читается как разговор: кому пишем →
          что пишем → как аккуратно. */}
      {showBlock('templates') && cfg.messagePrompts && (
        <SectionCard icon={<Sparkles size={18} />} title="AI / промпты">
          <div className="space-y-3">
            <AiGenerationNotice />
            <GlobalPromptEditor />
            <PromptCards
            moduleKey={moduleKey}
            labels={cfg.messagePrompts}
            activeIndex={activePrompt}
            onActiveChange={setActivePrompt}
            onBodiesChange={setPromptBodies}
          />
            {/* Распределение типов — часть промптов, а не лимитов (правка 19.08):
                проценты делятся между теми самыми карточками промптов, что выше.
                В «Параметрах и лимитах» блок стоял вдали от того, чем управляет. */}
          {/* Объём задачи: режим работы, сколько сделает аккаунт, минимум слов. Раньше это
            жило внутри «Таймингов» вместе с задержками — то есть «сколько» и «как быстро»
            стояли в одной куче (правка 19.08). */}
        {/* Распределение типов — везде, где есть карточки промптов (правка 19.08).
            Раньше блок жил только у нейрокомментинга, хотя набор промптов такой же у
            чаттинга, диалогов и мейлинга — там молча работал один и тот же тип. */}
        {showBlock('templates') && !running && (cfg.messagePrompts?.length ?? 0) > 0 && (
            <div className="mb-3 rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-fg">Распределение типов</span>
                <div className="flex items-center gap-2">
                  <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${weightSum === 100 ? 'bg-spark-500/15 text-spark-300' : weightSum > 100 ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>
                    сумма {weightSum}%
                  </span>
                  {weightSum !== 100 && (
                    <button type="button" onClick={() => balanceTypeWeights()} className="rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-spark-300 hover:bg-elevated">поровну</button>
                  )}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(cfg.messagePrompts ?? []).map((label, i) => {
                  const val = typeWeights[i] ?? 0
                  const share = weightSum > 0 ? Math.round((val / weightSum) * 100) : 0
                  const locked = !!lockedWeights[i]
                  const count = cfg.messagePrompts?.length ?? 0
                  return (
                    <div key={i} className="rounded-xl border border-line bg-surface/40 p-2">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{label}</span>
                        {/* §13 (MR-61): замок закрепляет значение — при изменении других оно не
                            трогается; редактировать закреплённое можно, сняв замок. */}
                        <button type="button" onClick={() => toggleWeightLock(i)}
                          title={locked ? 'Открепить значение' : 'Закрепить: не менять при перераспределении'}
                          className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md border', locked ? 'border-spark-500/50 bg-spark-500/10 text-spark-300' : 'border-line text-white/40 hover:text-white/70')}>
                          {locked ? <Lock size={13} /> : <LockOpen size={13} />}
                        </button>
                        {/* §13 (MR-60/61): ввод незакреплённого значения авто-перераспределяет
                            остаток между другими незакреплёнными; сумма всегда ≤ 100%. */}
                        <div className="flex shrink-0 items-center gap-1">
                          <input
                            type="number" min={0} max={100} inputMode="numeric" disabled={locked}
                            className="input h-7 w-16 text-center text-sm [appearance:textfield] disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            value={val}
                            // Клик по полю выделяет значение целиком: иначе ввод дописывался
                            // к нулю и получалось «012», «055» вместо «12», «55».
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => {
                              // Срезаем ведущие нули — «07» это 7, а не 07.
                              const n = Number(e.target.value.replace(/^0+(?=\d)/, '')) || 0
                              setTypeWeights((w) => {
                                const base = w.length === count ? w : equalize(count)
                                // §13 (уточнение): сохраняем залоченные И ранее введённые (touched) поля;
                                // остаток делят только НЕтронутые незалоченные.
                                const pinned = base.map((_, j) => j !== i && (!!lockedWeights[j] || !!touchedWeights[j]))
                                return redistribute(base, i, n, pinned)
                              })
                              // §13: это поле теперь «тронуто» — при следующих правках его не перезапишем.
                              setTouchedWeights((t) => { const nt = [...t]; nt[i] = true; return nt })
                            }} />
                          <span className="text-[11px] text-white/40">%</span>
                        </div>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className={cn('h-full rounded-full transition-all', locked ? 'bg-spark-400' : 'bg-spark-500')} style={{ width: `${share}%` }} /></div>
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 text-[11px] text-white/40">Ввод значения авто-раскидывает остаток по незакреплённым (§13). Замок — закрепить долю. «Поровну» — поделить незакреплённые одинаково.</p>
            </div>
          )}
          </div>
        </SectionCard>
      )}

      {showBlock('templates') && cfg.reactionPalette && (
        <SectionCard icon={<Heart size={18} />} title="Эмодзи">
          <div className="flex flex-wrap gap-2">
            {cfg.reactionPalette.map((e) => (
              <button key={e} type="button" onClick={() => { const n = new Set(palette); n.has(e) ? n.delete(e) : n.add(e); setPalette(n) }} className={`grid h-11 w-11 place-items-center rounded-xl border text-xl ${palette.has(e) ? 'border-spark-500/50 bg-spark-500/12' : 'border-line bg-elevated'}`}>{e}</button>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Правка 14.08: для ПРОГРЕВА блок «Защита» не показываем — он дублировал «Уровень
          прогрева» (уровень уже задаёт безопасный темп и множитель пауз). Базовая защита
          (FloodWait→пауза→карантин) работает на бэкенде и без UI-блока. QA §8, вариант а. */}
      {showBlock('settings') && !cfg.warmingLayout && (cfg.aiProtection || cfg.richLayout || cfg.lookingLayout || isGgr) && (
        <div id="sec-settings" className="scroll-mt-24">
        {/* Тот же компонент, что в мейлинге, автопостинге, нейродиалогах и парсерах:
            один вид и один порядок полей во всех модулях (правка 19.08). */}
        <ProtectionTimings
          badge={targets.length ? `${targets.length} целей` : undefined}
        >
          {/* Пресеты темпа и «Расширенные настройки» — первым делом в блоке. */}
          {!isParser && !isGgr && !cfg.warmingLayout && (
          <TimingSection
            bare
            part="delays"
            workModeOptions={cfg.toggleGroups?.[1]?.options}
            workMode={g(1)}
            onWorkMode={(v) => setTg(1, v)}
            workModeLabel={cfg.toggleGroups?.[1]?.label}
            durationMinutes={durationMinutes}
            onDuration={setDurationMinutes}
            showDurationAlways={!!cfg.reactionSettings}
            durationPeriodHint={`Период работы: ${durationPeriodMin}–${durationMinutes} мин`}
            totalLabel={cfg.reactionSettings?.max.label ?? cfg.workModeFields?.maxLabel ?? 'Всего действий'}
            computedTotal={{ value: maxActions, accounts: accCount }}
            perAccount={{ min: minPerAcc, max: maxPerAcc, onMin: setMinPerAcc, onMax: setMaxPerAcc }}
            minWords={cfg.workModeFields?.minWords ? { value: minWords, onChange: setMinWords } : null}
            delays={delays}
            onDelays={(updater) => setDelays(updater)}
            showComment={!!cfg.richLayout && !cfg.reactionSettings && moduleKey === 'neuro-commenting'}
            showAction={!(cfg.richLayout && !cfg.reactionSettings && moduleKey === 'neuro-commenting')}
            showJoin
            labels={{ action: cfg.reactionSettings ? 'Задержка между реакциями' : 'Задержка действия', join: 'Задержка вступления' }}
            delayPresets={cfg.delayPresets ?? ['Агрессивный', 'Сбалансированный', 'Консервативный']}
            delayPreset={delayPreset}
            onDelayPreset={setDelayPreset}
          />
          )}

          {/* MR-134: галочка вкл/выкл уведомлений о статусе ЭТОЙ задачи (ошибка/пауза) в колокольчике. */}
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-line/60 bg-elevated/40 px-3 py-2.5">
            <input type="checkbox" checked={notifyStatus} onChange={(e) => setNotifyStatus(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark-500" />
            <span>
              <span className="text-xs font-semibold text-fg">Уведомлять о статусе задачи</span>
              <span className="mt-0.5 block text-[11px] text-white/45">Ошибка или пауза этой задачи попадут в колокольчик. Снимите, если не нужны уведомления по ней.</span>
            </span>
          </label>

          {/* Правка 14.08: дубль «Уровень прогрева» здесь убран — он рендерился и в этом блоке,
              и отдельным блоком ниже. Оставлен один отдельный блок «Уровень прогрева». */}

          {cfg.reactionSettings ? (
            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              <ToggleGroup label="Режим" options={cfg.reactionSettings.modes} value={g(0)} onChange={(v) => setTg(0, v)} />
              {g(0) === 0 ? (
                <p className="text-xs text-muted">
                  Реакции только на посты, вышедшие <b className="text-fg">после старта задачи</b>. Первый заход в канал
                  запоминает последний пост и ничего не ставит — дальше реагируем на каждый новый.
                </p>
              ) : (
                <div className="space-y-1">
                  <NumberField label="Сколько последних постов" value={lastPostsCount} onChange={setLastPostsCount} min={1} max={20} />
                  <p className="text-xs text-muted">Аккаунты разбирают N последних постов канала; один аккаунт — одна реакция на пост.</p>
                </div>
              )}
              {/* Ползунок вероятности переехал в «Параметры и лимиты» — он про объём
                  («сколько из подходящих реально сделаем»), а не про защиту. */}
            </div>
          ) : cfg.toggleGroups && moduleKey !== 'neuro-commenting' ? (
            /* Отбор постов у нейрокомментинга живёт в «Параметрах и лимитах» — вплотную к
               полю «сколько последних постов». Здесь для него не остаётся ничего, и рамка
               рисовалась пустой полосой (правка 19.08). У остальных модулей группа тут. */
            <div className="rounded-2xl border border-line bg-elevated/40 p-4 space-y-4">
              <ToggleGroup label={cfg.toggleGroups[0].label} options={cfg.toggleGroups[0].options} value={g(0)} onChange={(v) => setTg(0, v)} />
            </div>
          ) : isParser ? (
            <div className="space-y-3">
              <label className="label">Ключевые слова / источник</label>
              <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className="input resize-none text-sm" />
              <NumberField label="Лимит результатов" value={maxActions} onChange={setMaxActions} />
            </div>
          ) : isGgr ? (
            <div className="space-y-3 text-sm text-muted">
              <p>
                Проверка идёт по <b className="text-fg">выбранным аккаунтам</b> (выберите их выше): подключаем сессию,
                запрашиваем профиль и складываем балл. Настройки не требуются — жмите «{cfg.primaryAction ?? 'Проверить'}».
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ['Живая сессия', '+50'],
                  ['Есть @username', '+15'],
                  ['Привязан телефон', '+10'],
                ].map(([label, pts]) => (
                  <div key={label} className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 px-3 py-2">
                    <span className="text-xs text-muted">{label}</span>
                    <span className="text-sm font-bold text-iris-300">{pts}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs">
                Валидный аккаунт получает статус «активный» и сохранённый балл. Мёртвая сессия — 0 и «разавторизирован».
                Сетевые ошибки и таймауты не понижают балл, аккаунты в карантине и спамблоке проверка не «лечит».
                Занятые другим модулем аккаунты пропускаются.
              </p>
            </div>
          ) : cfg.lookingLayout && cfg.lookModeOptions ? (
            <div className="rounded-2xl border border-line bg-elevated/40 p-4 space-y-4">
              <ToggleGroup
                label={cfg.lookModeLabel ?? 'Что смотреть'}
                options={cfg.lookModeOptions.map((o) => o.label)}
                value={lookModeIdx}
                onChange={setLookModeIdx}
              />
              {cfg.lookModeOptions[lookModeIdx]?.value !== 'stories' && (
                <div className="space-y-2">
                  <span className="label">{cfg.lookPostsLabel ?? 'Сколько последних постов смотреть'}</span>
                  <div className="flex flex-wrap gap-2">
                    {(cfg.lookPostsPresets ?? []).map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setLookPostsCount(p.value)}
                        className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all ${
                          lookPostsCount === p.value
                            ? 'border-spark-500/50 bg-spark-500/12 text-spark-300'
                            : 'border-line bg-elevated text-muted hover:border-spark-500/30 hover:text-fg'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <NumberField label="Произвольное число постов" value={lookPostsCount} onChange={setLookPostsCount} min={1} max={50} suffix="1–50" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">{cfg.warmingLayout
              ? 'Темп и паузы задаёт «Уровень прогрева» — отдельная секция ниже.'
              : 'Лимиты и задержки — ниже в этом же блоке.'}</p>
          )}
        </ProtectionTimings>
        </div>
      )}



      {/* §3.5: «Уровень прогрева» — ОТДЕЛЬНЫЙ блок (как «Тайминги и задержки»), а не
          строчка внутри «Параметры и лимиты»: это главный выбор прогрева, ему нужен свой
          заголовок. Показываем только для warming-модуля и не во время выполнения. */}
      {cfg.warmingLayout && !running && (
        <div id="sec-warm" className="scroll-mt-24">
        <SectionCard icon={<Flame size={18} />} title="Уровень прогрева">
          <div className="mb-1.5 text-xs text-white/40">Длиннее = естественнее</div>
          <Segmented options={WARM_LEVELS} value={warmLevel} onChange={setWarmLevel} />
          <div className="mt-3 rounded-lg border border-line/60 bg-elevated/40 px-3 py-2 text-[11px] text-white/50">
            💡 <b className="text-white/70">Уровень</b> задаёт темп (~40 / 20 / 10 действий в день) и множитель пауз. Для старта достаточно выбрать уровень — базовая защита от блокировок работает автоматически.
          </div>
          {/* Правка 14.08: блок «Защита» у прогрева убран (дублировал уровень) — галочку
              уведомлений перенесли сюда. */}
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-line/60 bg-elevated/40 px-3 py-2.5">
            <input type="checkbox" checked={notifyStatus} onChange={(e) => setNotifyStatus(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark-500" />
            <span>
              <span className="text-xs font-semibold text-fg">Уведомлять о статусе задачи</span>
              <span className="mt-0.5 block text-[11px] text-white/45">Ошибка или пауза прогрева попадут в колокольчик.</span>
            </span>
          </label>
        </SectionCard>
        </div>
      )}


      {/* §7: блок «История сообщений» убран. Результаты остаются только для парсера/проверки (GGR) —
          там это фактический вывод задачи. Логи выполнения — в Дашборде задач (ссылка выше). */}
      {(isParser || isGgr) && (showBlock('results') || showBlock('logs')) && (
        <SectionCard icon={<MessageCircle size={18} />} title="Результаты" badge={String(results.length)}>
          {results.length > 0 ? (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="py-2">Имя</th><th>Детали</th><th>Статус</th></tr></thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-line/50">
                      <td className="py-2 font-medium text-fg">{String(r.name ?? r.title ?? r.username ?? '—')}</td>
                      <td className="text-muted">{String(r.username ? `@${r.username}` : r.score ?? r.members ?? r.id ?? '')}</td>
                      <td><Badge tone={r.status === 'valid' ? 'spark' : 'muted'}>{String(r.status ?? r.kind ?? 'ok')}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Eye size={22} />} title="Пока пусто" desc={`Действий: ${progressDone}. Запустите проверку.`} />
          )}
        </SectionCard>
      )}

      {!(['run', 'settings', 'targets', 'templates', 'results', 'logs'] as const).some(showBlock) && (
        <div className="rounded-2xl border border-line bg-elevated/40 p-6 text-center text-sm text-muted">
          Роли выдан доступ к модулю, но не выдан ни один блок. Обратитесь к администратору, чтобы он открыл нужные блоки в «Роли и доступы».
        </div>
      )}

      {/* Статус задачи со страницы модуля УБРАН (правка 19.08). Модуль — это форма
          запуска: настроил и нажал. Всё, что происходит после запуска — прогресс,
          «Завершено», логи, стоп и пауза — живёт в Дашборде задач, и держать вторую
          витрину статуса значило показывать одно и то же в двух местах и чинить
          рассинхрон между ними. Ссылка на задачи модуля осталась в панели запуска. */}
      {/* Плавающая панель запуска — ПОСЛЕДНИЙ элемент страницы: её заглушка
          резервирует место внизу, и бар «отрывается» ко дну экрана. Подними её
          выше — заглушка встанет в середину, а бар задвоится.  */}
      {/* §10 (MR-49): выбор кампании и цели убран из модулей — эти разделы скрыты
          из меню, и держать их выбор здесь было некуда. Задача запускается сама по
          себе; привязка к кампании/цели приходит из настроек кампании при запуске
          через неё (buildCampaignPlan прокидывает campaignId и goalId в settings).
          Состояние campaignId/goalId оставлено: оно всё ещё уходит в задачу. */}
      {showBlock('run') && (() => {
        // Панель запуска одна на все модули. Разница только в оформлении: там, где
        // карточка «Параметры и лимиты» уже показана выше (нейрокомментинг), панель
        // идёт голой; где своих параметров нет (прогрев, масслукинг и др.) — она
        // оформляется той же карточкой, как было до переноса 19.08.
        const panel = (
          <LaunchPanel
            running={running}
            starting={starting}
            canStart={canStart}
            onStart={handleStart}
            onStop={stop}
            onSave={handleSave}
            primaryLabel={cfg.primaryAction ?? 'Начать'}
            cost={<LaunchCost compact moduleKey={moduleKey} actions={maxActions} accounts={selected.size} delaySec={(() => { const m = PRESET_MUL[delayPreset] ?? 1; const d = delays.action ?? delays.comment; return d ? [Math.round(d[0] * m), Math.round(d[1] * m)] as [number, number] : d })()} />}
            stats={launchStats}
            task={task}
            warn={warn}
            // Кнопка серая — прямо в панели говорим, ЧТО именно осталось заполнить,
            // а не только баннером выше по странице (правка заказчика).
            blockedBy={!running && !canStart
              ? (goalExpired ? ['дедлайн цели истёк — продлите или уберите цель']
                : typesOver100 ? [`сумма типов ${weightSum}% > 100 — уменьшите`]
                  : missingRequired)
              : []}
            // §11 (MR-55): шаги запуска — компактной строкой ПОД кнопкой запуска (а не
            // большим блоком вверху страницы): всё видно сразу, без прокрутки.
            steps={!running ? <LaunchSteps steps={launchSteps} /> : null}
            presets={presets}
            onApplyPreset={applyPreset}
            extras={(
              <>
                {/* §6: автоматизация прямо в модуле — запуск по времени, одно-/многоразово.
                    Идёт в extras (перед плавающим баром), иначе рендерился бы под баром внизу экрана. */}
                {!running && (
                  <div className="mt-3 rounded-xl border border-line bg-elevated/30">
                    <button type="button" onClick={() => setSchedOpen((v) => !v)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-muted hover:text-fg">
                      <Clock size={15} className="text-iris-300" />
                      Запуск по расписанию
                      <span className="text-xs font-normal text-faint">— создать правило, не запуская сейчас</span>
                      <span className="ml-auto text-xs text-faint">{schedOpen ? 'скрыть ▲' : 'настроить ▾'}</span>
                    </button>
                    {schedOpen && (
                      <div className="space-y-3 border-t border-line px-3 pb-3 pt-3">
                        <Segmented options={['Однократно', 'Ежедневно', 'Каждые N минут']} value={schedMode} onChange={setSchedMode} size="sm" />
                        {schedMode === 0 && (
                          <div>
                            <div className="mb-1 text-xs text-white/50">Дата и время запуска</div>
                            <input type="datetime-local" className="input h-9" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                          </div>
                        )}
                        {schedMode === 1 && (
                          <div>
                            <div className="mb-1 text-xs text-white/50">Время ежедневного запуска</div>
                            <input type="time" className="input h-9 w-32" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
                          </div>
                        )}
                        {schedMode === 2 && (
                          <div>
                            <div className="mb-1 text-xs text-white/50">Интервал (минуты)</div>
                            <input type="number" min={1} className="input h-9 w-32" value={schedEvery} onChange={(e) => setSchedEvery(Math.max(1, Number(e.target.value) || 1))} />
                          </div>
                        )}
                        <p className="text-[11px] text-white/40">
                          Правило заберёт текущие настройки модуля{campaignId ? ' и кампанию' : ''}. Управление — в разделе «Автоматизация».
                        </p>
                        <button type="button" onClick={() => void createSchedule()} disabled={schedSaving || !canStart}
                          className="btn-ghost h-9 text-sm disabled:opacity-40">
                          <Clock size={14} /> {schedSaving ? 'Создание…' : 'Создать правило'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
  
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <a href={`/panel/tasks?module=${moduleKey}${task ? `&task=${task.id}` : ''}`} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-spark-300 hover:underline" title="Открыть Дашборд задач, отфильтрованный по этому модулю">
                    <Terminal size={13} /> Логи выполнения — в Дашборде задач <ArrowUpRight size={13} />
                  </a>
                </div>
              </>
            )}
          />
        )
        if (hasParamsCard) return panel
        return (
          <div id="sec-run" className="scroll-mt-24">
          <SectionCard icon={<Play size={18} />} title="Параметры и лимиты">
          {limitWarn && !running && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">⚠ {limitWarn}</div>
          )}
          <p className="mb-3 text-sm text-muted">{cfg.warmingLayout
            ? 'Темп и паузы задаёт «Уровень прогрева» — секция выше.'
            : 'Лимиты и задержки — в блоке «Защита и тайминги» выше.'}</p>
            {panel}
          </SectionCard>
          </div>
        )
      })()}

    </div>
  )
}
