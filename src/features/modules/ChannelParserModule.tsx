import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Play, Sparkles, Search, Settings2, Timer, Users, Database, Filter, Radar,
  Plus, X, Trash2, Hash, ChevronRight,
  Bookmark, Zap, SlidersHorizontal, MessageCircle, Check, HelpCircle, Terminal, ArrowUpRight,
} from 'lucide-react'
import { MODULES, LANGUAGES, type ModuleConfig } from '@/shared/config/modules'
import { activeAccounts, useApp } from '@/mocks/store'
import { Segmented, Switch, Select, Tip } from '@/shared/ui'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { useModuleTask } from './shared/useModuleTask'
import { SectionCard, NumberField, ProtectionTimings, DelayFields, LaunchPanel, LaunchSteps, markCurrentStep, TaskStartedModal, SchedulePanel, usePresetCarry, useBlockAccess, ParserQueries } from './shared'
import { PresetBar } from './shared/PresetBar'
import { SavePresetModal, presetSettings } from './shared/SavePresetModal'
import { cn } from '@/shared/lib/utils'
import { ParserResultsView, qualityScore, type ParserResult } from './ParserResultsView'
import { LaunchCost } from './shared/LaunchCost'
import { fetchModuleTasks, fetchModuleTask, lookupParserCache, setParserWatch, suggestKeywords, type ModuleTaskSettings, type ModulePresetSettings, type ParserCacheHit, type KeywordSuggestion } from '@/api/modulesApi'

/** Собирает username ранее спарсенных каналов/групп из истории модуля (для дедупа между запусками). */
async function gatherAlreadyParsed(moduleKey: string): Promise<string[]> {
  try {
    const tasks = await fetchModuleTasks(moduleKey)
    const done = tasks.filter((t) => t.status === 'done').slice(0, 10)
    const names = new Set<string>()
    for (const t of done) {
      const full = await fetchModuleTask(moduleKey, t.id)
      for (const r of full.results || []) {
        const u = (r as { username?: string }).username
        if (u) names.add(String(u).toLowerCase())
      }
    }
    return [...names]
  } catch { return [] }
}

/** Словари окончаний для комбинации с ключевыми словами (расширение поиска). */
const ENDINGS: Record<string, string[]> = {
  en: ['chat', 'channel', 'news', 'official', 'group', 'community', 'forum', 'club', 'hub', 'bot', 'shop', 'service', 'store', 'team', 'pro', 'live', 'daily', 'world', 'zone', 'space'],
  ru: ['чат', 'канал', 'новости', 'официальный', 'группа', 'сообщество', 'форум', 'клуб', 'бот', 'магазин', 'сервис', 'мир', 'зона', 'команда', 'про', 'лайв', 'дейли', 'обзор', 'топ', 'инфо'],
  ua: ['чат', 'канал', 'новини', 'офіційний', 'група', 'спільнота', 'форум', 'клуб', 'бот', 'магазин', 'сервіс', 'світ', 'зона', 'команда', 'про', 'лайв', 'дейлі', 'огляд', 'топ', 'інфо'],
}



/** Общая формула для легенды. */
/**
 * Потолок для диапазона участников. У Telegram самые крупные каналы — десятки миллионов,
 * так что 100 млн с запасом; смысл цифры не в точности, а в том, чтобы в поле нельзя было
 * вписать 1e31 и отправить это в задачу как настоящий фильтр.
 */
const MEMBERS_CAP = 100_000_000
const clampMembers = (v: string) => Math.min(MEMBERS_CAP, Math.max(0, Math.round(Number(v) || 0)))


export function ChannelParserModule({ moduleKey }: { moduleKey: string }) {
  const cfg = MODULES[moduleKey]
  if (!cfg) return null
  return <ChannelParserInner cfg={cfg} moduleKey={moduleKey} />
}

function ChannelParserInner({ cfg, moduleKey }: { cfg: ModuleConfig; moduleKey: string }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const pushToast = useApp((s) => s.pushToast)
  const { task, running, starting, start, stop, savePreset, deletePreset, editPreset, presets, justStarted, dismissJustStarted } = useModuleTask(moduleKey)

  const isGroups = moduleKey === 'parsing-groups'
  const resultLabel = cfg.resultLabel ?? (isGroups ? 'ГРУППА' : 'КАНАЛ')

  // ── аккаунты и защита ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)

  // ── метод + ключевые слова ──
  const [method, setMethod] = useState(0) // 0 keywords, 1 similar
  const [keywords, setKeywords] = useState<string[]>(cfg.defaultKeywords ?? [])
  const [kwInput, setKwInput] = useState('')
  // Подсказка строится от того, что человек набрал, а не берётся из конфига витрины.
  const [suggests, setSuggests] = useState<KeywordSuggestion[]>([])
  const [suggestBusy, setSuggestBusy] = useState<'' | 'intent' | 'ai'>('')
  const [suggestErr, setSuggestErr] = useState('')
  const runSuggest = useCallback(async (mode: 'intent' | 'ai') => {
    setSuggestBusy(mode); setSuggestErr('')
    try {
      const r = await suggestKeywords(keywords, mode)
      // Уже показанные варианты не затираем: человек мог нажать обе кнопки подряд.
      setSuggests((prev) => {
        const have = new Set([...prev.map((p) => p.w.toLowerCase()), ...keywords.map((k) => k.toLowerCase())])
        return [...prev, ...r.items.filter((i) => !have.has(i.w.toLowerCase()))]
      })
      // Молчать про выключенный ИИ нельзя: пусто и пусто — выглядит как поломка.
      if (mode === 'ai' && r.aiMode !== 'openai') setSuggestErr(r.reason || 'ИИ не ответил — остаются наши шаблоны')
      else if (!r.items.length) setSuggestErr('Новых вариантов нет — всё уже в списке')
    } catch (e) {
      setSuggestErr(e instanceof Error ? e.message : 'Не удалось получить подсказку')
    } finally { setSuggestBusy('') }
  }, [keywords])

  // ── окончания ──
  const [useEndings, setUseEndings] = useState(true)
  const [endMode, setEndMode] = useState(1) // 0 вручную, 1 авто
  const [endLang, setEndLang] = useState(cfg.endLangDefault ?? 'en')
  const [endCount, setEndCount] = useState(10)
  const [manualEndings, setManualEndings] = useState<string[]>([])
  const [manualEndInput, setManualEndInput] = useState('')

  // ── фильтры / лимиты ──
  const [fastWork, setFastWork] = useState(false)
  const [skipParsed, setSkipParsed] = useState(false)
  const [intersect, setIntersect] = useState(true) // #7: по умолчанию ПЕРЕСЕЧЕНИЕ (AND) — уже, точнее
  const [limit, setLimit] = useState<number>(cfg.defaultLimit === '∞' ? 0 : (cfg.defaultLimit ?? 50)) // 0 = без лимита
  const [activity, setActivity] = useState(cfg.defaultActivity ?? 0)
  const [commentFilter, setCommentFilter] = useState(0)
  const [minComments, setMinComments] = useState(0)
  const [minMembers, setMinMembers] = useState<number | ''>(cfg.defaultMinMembers ?? 100)
  const [maxMembers, setMaxMembers] = useState<number | ''>(100000)
  const [langDetect, setLangDetect] = useState(false)
  const [minRating, setMinRating] = useState(1)
  const [templatesOpen, setTemplatesOpen] = useState(!cfg.templatesCollapsed)

  // ── задержки ──
  const [reqDelay, setReqDelay] = useState<[number, number]>([2, 2])
  const [chDelay, setChDelay] = useState<[number, number]>([1, 1])

  // ── результаты ──
  // Поиск, сортировка, страницы и выгрузки живут в общем `ParserResultsView` (27.08):
  // тот же вид теперь и на странице задачи. Здесь остаётся только то, что относится
  // к ОТБОРУ (фильтр по рейтингу) и к источнику показа (кэш/живая задача).
  const [cleared, setCleared] = useState(false)
  // §6 (MR-38): кэш парсинга — есть ли сохранённый результат под текущий запрос, и
  // показываем ли мы его сейчас (вместо результатов живой задачи).
  // Права на блоки (26.08): до этой правки проверка жила только в LiveModule, и
  // выданные парсеру блоки ни на что не влияли — тумблер щёлкали, экран не менялся.
  const showBlock = useBlockAccess(moduleKey)

  const [cacheHit, setCacheHit] = useState<ParserCacheHit | null>(null)
  const [usingCache, setUsingCache] = useState(false)

  /*
   * Окончания — необязательная надстройка (просьба владельца 26.08). Раньше их нельзя было
   * выключить: 6 слов молча превращались в 66 запросов, а это шестьдесят шесть обращений к
   * Telegram вместо шести — дольше и рискованнее по FloodWait. Когда нужен точный поиск по
   * самим словам, расширение только мешает.
   */
  const endings = useMemo(() => {
    if (!useEndings) return []
    if (endMode === 0) return manualEndings
    return (ENDINGS[endLang] ?? ENDINGS.en).slice(0, endCount)
  }, [useEndings, endMode, manualEndings, endLang, endCount])

  const queryCount = keywords.length + keywords.length * endings.length

  // §6 (MR-38): при совпадающем запросе спрашиваем базу — есть ли сохранённый результат.
  // Дебаунс, чтобы не дёргать сервер на каждый набранный символ; во время работы задачи
  // не спрашиваем (там копится живой результат). Сигнатура на сервере — по составу отбора.
  useEffect(() => {
    if (running || keywords.length === 0) { setCacheHit(null); setUsingCache(false); return }
    const settings: Partial<ModuleTaskSettings> = {
      keywords, endings,
      minMembers: minMembers === '' ? 0 : minMembers,
      maxMembers: maxMembers === '' ? 0 : maxMembers,
      commentFilter,
      intersect: intersect && method === 0,
    }
    let cancelled = false
    const t = setTimeout(() => {
      void lookupParserCache(moduleKey, settings).then((hit) => { if (!cancelled) setCacheHit(hit) }).catch(() => {})
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [moduleKey, running, keywords, endings, minMembers, maxMembers, commentFilter, intersect, method])


  /*
   * Слежение за запросом (просьба владельца 24.08): раз в сутки перезапускать тот же
   * парс, искать новые каналы и отмечать пропавшие. Выключено по умолчанию и включается
   * тут же, рядом с сохранённым результатом: перепроверка — это реальный проход по
   * аккаунтам и списание монет, включать её за человека молча нельзя.
   */
  const [watching, setWatching] = useState(false)
  const [watchBusy, setWatchBusy] = useState(false)
  useEffect(() => { setWatching(false) }, [cacheHit?.updatedAt])
  const toggleWatch = async (on: boolean) => {
    setWatchBusy(true)
    try {
      await setParserWatch(moduleKey, { keywords, endings, minMembers: minMembers === '' ? 0 : minMembers, maxMembers: maxMembers === '' ? 0 : maxMembers, commentFilter, intersect: intersect && method === 0 }, on, 24)
      setWatching(on)
      pushToast({ type: 'success', title: on ? 'Слежу за запросом' : 'Слежение выключено', desc: on ? 'Раз в сутки перепроверю и найду новое' : undefined })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не вышло', desc: e instanceof Error ? e.message : 'Ошибка' })
    } finally { setWatchBusy(false) }
  }


  const addKeywords = () => {
    // MR-104: разделитель ключевых слов — точка с запятой (и перенос строки), чтобы сама фраза могла содержать запятую.
    const parsed = kwInput.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setKeywords((k) => [...new Set([...k, ...parsed])])
    setKwInput('')
  }
  const addManualEndings = () => {
    const parsed = manualEndInput.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setManualEndings((e) => [...new Set([...e, ...parsed])])
    setManualEndInput('')
  }

  const applyTemplate = (chips: string[]) => {
    setKeywords((k) => [...new Set([...k, ...chips])])
    pushToast({ type: 'success', title: 'Шаблон применён', desc: `+${chips.length} ключевых слов` })
  }

  const { carry, remember } = usePresetCarry()

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    ...carry(), // параметры шаблона, которым нет ручки в форме (напр. delayPreset у MCP-задач)
    accountIds: [...selected],
    keywords,
    endings,
    searchMode: method,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    resultLimit: limit,
    limit,
    activityFilter: activity,
    commentFilter,
    minComments,
    // Теперь эти три реально применяются на сервере (26.08): активность и минимум
    // комментариев считаются по постам канала, балл — наш собственный.
    minRating,
    minMembers: minMembers === '' ? 0 : minMembers,
    maxMembers: maxMembers === '' ? 0 : maxMembers,
    langDetection: langDetect,
    intersect: intersect && method === 0,
    delays: {
      request: fastWork ? [0, 0] : reqDelay,
      channel: fastWork ? [0, 0] : chDelay,
      floodWait: 120,
      floodQuarantine: 3,
    },
  }), [carry, selected, keywords, endings, method, aiProtect, protLevel, limit, activity, commentFilter, minComments, minRating, minMembers, maxMembers, langDetect, intersect, fastWork, reqDelay, chDelay])

  const busySelectedCount = useMemo(
    () => [...selected].filter((id) => accounts.some((a) => a.id === id && a.busyIn)).length,
    [selected, accounts],
  )
  const canStart = selected.size > 0 && busySelectedCount === 0 && keywords.length > 0
  const warn = !canStart
    ? (busySelectedCount ? `${busySelectedCount} акк. заняты в другом модуле` : !selected.size ? 'Выберите аккаунты' : 'Добавьте хотя бы одно ключевое слово')
    : undefined

  const handleStart = async () => {
    setCleared(false)
    setUsingCache(false) // §6: свежий запуск показывает живой результат, не кэш
    const settings = buildSettings()
    if (skipParsed) {
      const seen = await gatherAlreadyParsed(moduleKey)
      settings.alreadyParsed = seen
      if (seen.length) pushToast({ type: 'info', title: `Исключаем ${seen.length} уже спарсенных` })
    }
    void start(settings, `${cfg.title} · ${selected.size} акк.`)
  }
  // §10: сохранение через модалку (имя + цвет + владелец), как в остальных модулях.
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  const handleSave = () => setPresetModalOpen(true)

  const applyPreset = useCallback((s: ModulePresetSettings) => {
    remember(s)
    if (Array.isArray(s.keywords)) setKeywords(s.keywords)
    if (s.searchMode !== undefined) setMethod(s.searchMode)
    /*
     * Окончания в шаблоне лежат уже развёрнутым списком, поэтому «выключено» отличается от
     * «включено» только его пустотой. Пустой список → тумблер снят: иначе шаблон, сохранённый
     * без окончаний, применялся бы с ними и молча раздувал число запросов в одиннадцать раз.
     */
    if (Array.isArray(s.endings)) {
      setUseEndings(s.endings.length > 0)
      if (s.endings.length) { setEndMode(0); setManualEndings(s.endings) }
    }
    if (s.aiProtection !== undefined) setAiProtect(s.aiProtection)
    if (s.protectionLevel !== undefined) setProtLevel(s.protectionLevel)
    const lim = s.resultLimit ?? s.limit
    if (lim !== undefined) setLimit(Number(lim) || 0)
    if (s.activityFilter !== undefined) setActivity(s.activityFilter)
    // Балл тоже часть отбора, а не украшение — шаблон обязан его восстанавливать,
    // иначе применённый шаблон соберёт не то, что собирал раньше.
    if (s.minRating !== undefined) setMinRating(Number(s.minRating) || 1)
    if (s.commentFilter !== undefined) setCommentFilter(s.commentFilter)
    if (s.minComments !== undefined) setMinComments(s.minComments)
    if (s.minMembers !== undefined) setMinMembers(s.minMembers)
    if (s.maxMembers !== undefined) setMaxMembers(s.maxMembers)
    if (s.langDetection !== undefined) setLangDetect(s.langDetection)
    if (s.delays?.request) setReqDelay(s.delays.request)
    if (s.delays?.channel) setChDelay(s.delays.channel)
    if (s.intersect !== undefined) setIntersect(s.intersect)
    // См. парсер участников: «Быстрая работа» узнаётся по нулевым задержкам, своего
    // поля в шаблоне у неё нет.
    const req = s.delays?.request, ch = s.delays?.channel
    if (req && ch) setFastWork(req[0] === 0 && req[1] === 0 && ch[0] === 0 && ch[1] === 0)
    pushToast({ type: 'success', title: 'Шаблон применён' })
  }, [pushToast, remember])

  // §6 (MR-38): показываем либо результат живой задачи, либо сохранённый из базы (когда
  // пользователь нажал «Показать из базы» под совпавший запрос).
  const rawResults = (cleared
    ? []
    : (usingCache && cacheHit ? (cacheHit.results as ParserResult[]) : (task?.results ?? []))) as ParserResult[]

  const results = useMemo(() => {
    /*
     * Фильтр по рейтингу качества ★ (показывать только >= выбранного).
     *
     * Балл считает СЕРВЕР по живым сигналам канала (посты, свежесть, отклик), и слабые
     * строки он уже не присылает. Здесь оставлен запасной фильтр для результатов, собранных
     * до этой правки: у них поля `score` нет, и раньше рейтинг считался из одних подписчиков —
     * по нему нельзя было отличить живой канал от брошенного год назад.
     */
    if (minRating > 1) return rawResults.filter((x) => (x.score ?? qualityScore(x.members ?? 0, x.hasComments)) >= minRating)
    return rawResults
  }, [rawResults, minRating])

  const launchStats = [
    { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
    { icon: <Search size={18} />, color: '#06b6d4', label: 'Ключевые слова', value: String(keywords.length) },
    { icon: <Hash size={18} />, color: '#0ec464', label: 'Запросов', value: String(queryCount) },
    { icon: <Database size={18} />, color: '#f59e0b', label: 'Макс. результатов', value: limit === 0 ? '∞' : String(limit) },
  ]

  return (
    <div className="space-y-4">
      <TaskStartedModal task={justStarted} moduleTitle={cfg.title} onClose={dismissJustStarted} />
      <SavePresetModal open={presetModalOpen} onClose={() => setPresetModalOpen(false)}
        onSave={(name, color, owner, withAccounts) => savePreset(name, presetSettings(buildSettings(), withAccounts), color, owner)} />
      {/* ТЗ 06.08 §10: выбор шаблона — вверху, до всех настроек (TPL-001). */}
      <PresetBar presets={presets} onApply={applyPreset} onSave={handleSave}
        onEdit={editPreset} onDelete={deletePreset} disabled={running} />
      {/* Выбор аккаунтов */}
      <div id="sec-accounts" className="scroll-mt-24">
        {/*
          Подсказка стоит НАД выбором аккаунтов (просьба владельца 26.08): вопрос «сколько
          отмечать» возникает до выбора, а не после. Настройки здесь нет — аккаунты всегда
          ищут одновременно, поэтому это именно объяснение, а не тумблер.
        */}
        <div className="mb-3 flex items-start gap-2.5 rounded-2xl border border-spark-500/30 bg-spark-500/8 px-4 py-3">
          <Zap size={16} className="mt-0.5 shrink-0 text-spark-300" />
          <div className="min-w-0 text-xs leading-relaxed text-white/60">
            <span className="font-bold text-fg">Чем больше аккаунтов, тем быстрее парсинг.</span>{' '}
            {/*
              Множитель «в N раз быстрее» тут не пишем: при 80 аккаунтах это обещание,
              которого Telegram не даст, — то же враньё, что выдуманные проценты. Полезнее
              показать реальную нагрузку: сколько запросов достанется одному аккаунту.
            */}
            {selected.size > 1
              ? `${queryCount} запросов разойдутся между ${selected.size} аккаунтами — примерно по ${Math.max(1, Math.ceil(queryCount / selected.size))} на каждый. Каждый берёт следующий свободный, поэтому медленный не задерживает остальных, а стартуют они вразнобой.${selected.size > queryCount ? ' Аккаунтов выбрано больше, чем запросов, — лишние просто не понадобятся.' : ''}`
              : 'Запросы делятся между выбранными аккаунтами и идут одновременно, поэтому сбор заканчивается тем быстрее, чем больше аккаунтов отмечено.'}
            <span className="mt-1 block text-white/35">
              Плюс к скорости это ещё и безопаснее: на каждый профиль приходится меньше запросов, а FloodWait прилетает именно за частоту с одного.
            </span>
          </div>
        </div>
        <AccountPicker moduleKey={moduleKey} selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано для парсинга'} />
      </div>

      {/* Шаблоны */}
      {cfg.templates && cfg.templates.length > 0 && (
        <SectionCard icon={<Bookmark size={18} />} title={cfg.templatesTitle ?? 'Шаблоны'} badge={cfg.templatesBadge}
          right={<button type="button" onClick={() => setTemplatesOpen((v) => !v)} className="btn-ghost h-8 text-xs">{templatesOpen ? 'Свернуть' : 'Развернуть'} <ChevronRight size={14} className={cn('transition-transform', templatesOpen && 'rotate-90')} /></button>}>
          {templatesOpen && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cfg.templates.map((t) => (
              <div key={t.name} className="flex flex-col rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/15 text-amber-300"><Bookmark size={15} /></span>
                  <span className="text-sm font-bold text-fg">{t.name}</span>
                </div>
                <p className="mt-2 line-clamp-1 text-xs text-muted">{t.desc}</p>
                <div className="mt-2 text-[11px] text-muted">🏷 {t.kw} ключевых слов</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.chips.slice(0, 3).map((c) => <span key={c} className="rounded-md border border-iris-500/30 bg-iris-500/10 px-1.5 py-0.5 text-[11px] text-iris-300">{c}</span>)}
                  {t.extra > 0 && <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-muted">+{t.extra}</span>}
                </div>
                <button type="button" onClick={() => applyTemplate(t.chips)} className="btn-soft mt-3 h-8 justify-center text-xs"><Check size={13} /> Применить</button>
              </div>
            ))}
          </div>
          )}
        </SectionCard>
      )}

      {/* Настройки поиска */}
      {showBlock('targets') && (
      <SectionCard id="sec-settings" icon={<Settings2 size={18} />} title="Настройки поиска" badge={`${keywords.length} ключевых слов`}>

        <div className="mb-4">
          <Segmented options={cfg.methodTabs?.slice(0, 2) ?? ['Поиск по ключевым словам', 'Похожие каналы']} value={method} onChange={setMethod} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Левая колонка: ключевые слова + окончания */}
          <div className="space-y-4">
            <div>
              <div className="label flex items-center gap-1.5"><Search size={14} /> Ключевые слова *</div>
              <div className="mb-1 text-[11px] text-muted">Несколько слов — через точку с запятой «;» или Enter. Так фраза может содержать запятую.</div>
              <div className="flex gap-2">
                <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKeywords()} className="input h-10 text-sm" placeholder="крипта; заработок в интернете; p2p…" />
                <button type="button" onClick={addKeywords} className="btn-primary h-10 shrink-0 px-4"><Plus size={16} /> Добавить</button>
              </div>
              {keywords.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {keywords.map((k) => (
                    <span key={k} className="inline-flex items-center gap-1.5 rounded-lg border border-spark-500/30 bg-spark-500/10 px-2.5 py-1 text-sm font-medium text-spark-300">
                      {k}
                      <button type="button" onClick={() => setKeywords((arr) => arr.filter((x) => x !== k))} className="text-spark-300/70 hover:text-rose-300"><X size={13} /></button>
                    </span>
                  ))}
                  <button type="button" onClick={() => setKeywords([])} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 px-2.5 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-500/10"><Trash2 size={12} /> Очистить всё</button>
                </div>
              )}
            </div>

            {/*
              Подсказка ключевых слов (просьба владельца 26.08: «можно это сделать,
              чтобы предложка реально работала?»). Раньше здесь был зашитый в конфиг
              список из шести слов, который не зависел от введённого, с выдуманными
              процентами рядом. Теперь два источника:
                • «Наши варианты» — шаблоны намерения, мгновенно и без токенов;
                • «Подобрать ИИ» — синонимы и переводы от модели.
              ИИ дёргаем по кнопке, а не на каждое нажатие клавиши: это сетевой запрос
              и расход токенов, и делать его молча за спиной владельца неправильно.
            */}
            <div className="rounded-2xl border border-iris-500/25 bg-iris-500/8 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-iris-300"><Sparkles size={14} /> Подсказать ключевые слова</div>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={() => runSuggest('intent')} disabled={!keywords.length || suggestBusy !== ''}
                    className="btn-soft h-7 px-2 text-[11px]">Наши варианты</button>
                  <button type="button" onClick={() => runSuggest('ai')} disabled={!keywords.length || suggestBusy !== ''}
                    className="btn-soft h-7 px-2 text-[11px]">{suggestBusy === 'ai' ? 'Думаю…' : 'Подобрать ИИ'}</button>
                </div>
              </div>

              {!keywords.length && <div className="text-[11px] text-muted">Добавьте хотя бы одно слово — подсказка строится от вашего списка.</div>}
              {suggestErr && <div className="text-[11px] text-amber-300">{suggestErr}</div>}

              {suggests.length > 0 && (
                <>
                  <div className="flex flex-wrap gap-2">
                    {suggests.map((a) => (
                      <button key={a.w} type="button" title={`${a.why}${a.from ? ` · от «${a.from}»` : ''}`}
                        disabled={keywords.includes(a.w)}
                        onClick={() => { setKeywords((k) => [...new Set([...k, a.w])]); setSuggests((s) => s.filter((x) => x.w !== a.w)) }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1 text-xs text-fg hover:border-iris-500/40 disabled:opacity-40">
                        {a.w}
                        <span className={cn('rounded px-1 text-[10px] font-bold', a.src === 'ai' ? 'bg-iris-500/20 text-iris-300' : 'bg-emerald-500/20 text-emerald-300')}>
                          {a.src === 'ai' ? 'ИИ' : 'намерение'}
                        </span>
                        <Plus size={12} className="text-iris-300" />
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <button type="button" onClick={() => { setKeywords((k) => [...new Set([...k, ...suggests.map((s) => s.w)])]); setSuggests([]) }}
                      className="btn-primary h-7 px-3 text-[11px]"><Plus size={12} /> Добавить все ({suggests.length})</button>
                    <button type="button" onClick={() => setSuggests([])} className="text-[11px] text-muted hover:text-fg">Скрыть</button>
                  </div>
                </>
              )}
            </div>

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                {/*
                  Что такое «окончания», по названию не догадаться (вопрос владельца 26.08:
                  «что это за окончание, добавь наводку что это значит»). Это слова, которые
                  дописываются к каждому ключевому: «крипто» → «крипто chat», «крипто news».
                  Так один запрос превращается в десяток и находит каналы, которые по голому
                  слову не выпадают.
                */}
                <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <Bookmark size={14} className={useEndings ? 'text-spark-400' : 'text-faint'} /> Окончания
                  <Tip text="Слова, которые дописываются к каждому ключевому слову: «крипто» → «крипто chat», «крипто news», «крипто official». Так поиск находит каналы, которые по голому слову не выпадают. Больше окончаний — шире охват и дольше сбор.">
                    <HelpCircle size={13} className="cursor-help text-white/35" />
                  </Tip>
                </span>
                <div className="flex items-center gap-2">
                  {useEndings && <Segmented size="sm" options={['Вручную', 'Авто']} value={endMode} onChange={setEndMode} />}
                  <Switch checked={useEndings} onChange={setUseEndings} />
                </div>
              </div>
              {!useEndings ? (
                <div className="text-[11px] leading-relaxed text-muted">
                  Ищем ровно по вашим словам: <b className="text-fg">{keywords.length}</b> {keywords.length === 1 ? 'запрос' : 'запросов'} вместо
                  {' '}{keywords.length + keywords.length * 10} с окончаниями. Быстрее и точнее, но каналы, у которых в названии
                  стоит «chat» или «news», могут не попасться.
                </div>
              ) : endMode === 1 ? (
                <div className="space-y-3">
                  <Select value={endLang} onChange={setEndLang} options={LANGUAGES.map((l) => ({ value: l.code, label: `${l.flag} ${l.label}` }))} />
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-muted"><span>Количество окончаний</span><span className="rounded bg-elevated px-1.5 font-bold text-spark-300">{endCount}</span></div>
                    <input type="range" min={5} max={20} value={endCount} onChange={(e) => setEndCount(Number(e.target.value))} className="w-full accent-spark-500" />
                    <div className="flex justify-between text-[10px] text-faint"><span>Быстро (5)</span><span>Тщательно (20)</span></div>
                  </div>
                  {/* Формула считалась «окончания × слова», но в запросы идут ещё и ГОЛЫЕ слова —
                      поэтому 10 × 9 давало на экране 99, и подпись противоречила сама себе. */}
                  <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] text-muted">
                    {keywords.length} слов + {keywords.length} × {endCount} окончаний = <b className="text-spark-300">{queryCount}</b> поисковых запросов
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input value={manualEndInput} onChange={(e) => setManualEndInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManualEndings()} className="input h-9 text-sm" placeholder="Окончания через ; или Enter…" />
                    <button type="button" onClick={addManualEndings} className="btn-soft h-9 shrink-0 px-3"><Plus size={15} /></button>
                  </div>
                  {manualEndings.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {manualEndings.map((e) => (
                        <span key={e} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-fg">{e}
                          <button type="button" onClick={() => setManualEndings((arr) => arr.filter((x) => x !== e))} className="text-faint hover:text-rose-300"><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Правая колонка: быстрые опции + фильтры + лимиты */}
          <div className="space-y-3">
            <ToggleRowInline icon={<Zap size={15} />} label="Быстрая работа" desc="Без задержек между запросами" checked={fastWork} onChange={setFastWork} />
            <ToggleRowInline icon={<Filter size={15} />} label="Не собирать уже спарсенные" desc="Вырежем каналы из логов парсинга" checked={skipParsed} onChange={setSkipParsed} />
            {method === 0 && keywords.length > 1 && (
              <ToggleRowInline
                icon={<Check size={15} />}
                label={intersect ? 'Пересечение (AND) — уже' : 'Объединение (OR) — шире'}
                desc={intersect
                  ? `Только каналы, совпавшие со ВСЕМИ ${keywords.length} ключами/шаблонами (напр. и IT, и Школа)`
                  : `Каналы, совпавшие с ЛЮБЫМ из ${keywords.length} ключей (напр. IT-каналы + Школа-каналы отдельно)`}
                checked={intersect}
                onChange={setIntersect}
              />
            )}
            {/* Пересечение считается по ВСЕМ ключам разом, поэтому применяется только
                когда пройдут все запросы. Пока идёт сбор, в результатах видно
                промежуточное — и это читается как «фильтр не работает». */}
            {method === 0 && keywords.length > 1 && intersect && (
              <div className={cn('rounded-xl border px-3 py-2 text-xs leading-relaxed',
                keywords.length > 3 ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-amber-500/25 bg-amber-500/8 text-amber-200/90')}>
                {/*
                  Прогон 26.08: 51 слово + пересечение дали 146 → 0, час работы впустую.
                  Пересечение требует, чтобы ОДИН канал нашёлся по КАЖДОМУ слову — это
                  выполнимо для 2–3 синонимов и практически невозможно для длинного списка,
                  особенно если слова добавлены подсказкой. Говорим об этом ДО запуска.
                */}
                {keywords.length > 3 ? (
                  <>
                    <b>С {keywords.length} словами пересечение почти наверняка даст 0.</b> Канал должен найтись
                    по КАЖДОМУ из них — так совпадают только близкие синонимы. Снимите галочку (тогда подойдёт
                    совпадение с любым словом) или оставьте 2–3 слова.
                  </>
                ) : (
                  <>
                    Пересечение применится <b>в конце</b>, когда пройдут все запросы. По ходу работы
                    в результатах будет видно промежуточный сбор — часть строк уйдёт, и монеты за них вернутся.
                  </>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              {/* Верхняя граница нужна не ради красоты: без неё в поле влезает число
                  вроде 1e31, и оно уезжает в задачу как настоящий лимит. */}
              <NumberField label="Лимит результатов" value={limit} onChange={setLimit} step={10} max={100000} />
              <div className="mt-1.5 text-xs text-white/40">0 = без лимита (все результаты)</div>
            </div>

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><SlidersHorizontal size={14} className="text-spark-400" /> Фильтр активности</div>
              <Segmented size="sm" options={['Любая активность', 'Только активные', 'Неактивные']} value={activity} onChange={setActivity} />
            </div>

            {cfg.commentFilter && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                {/*
                  Название не объясняет ни смысла, ни цены (вопрос владельца 26.08: «что за
                  фильтр комментариев и для чего он нужен?»). Два разных фильтра: первый —
                  можно ли писать вообще, он бесплатный; второй требует скачать посты
                  каждого кандидата и потому заметно замедляет сбор. Об этом и подсказки.
                */}
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <MessageCircle size={14} className="text-spark-400" /> Фильтр комментариев
                  <Tip text="Можно ли писать под постами. Открытыми считаются группы (пишут все) и каналы с привязанным чатом обсуждения. Нужен прежде всего для нейрокомментинга: в канал с закрытыми комментариями аккаунт зайдёт и не сможет написать ни слова. «Только закрытые» — для обратной задачи: собрать аудиторию или следить за каналом, не комментируя.">
                    <HelpCircle size={13} className="cursor-help text-white/35" />
                  </Tip>
                </div>
                <Segmented size="sm" options={['Любые', 'Только открытые', 'Только закрытые']} value={commentFilter} onChange={setCommentFilter} />
                <div className="mt-3">
                  <NumberField label="Мин. комментариев на пост" value={minComments} onChange={setMinComments} max={10000}
                    hint="Среднее число откликов по последним 20 постам. Отсекает каналы, где комментарии включены, но под постами пусто — писать туда некому. 0 — выключено. Внимание: ради этого парсер скачивает посты каждого найденного канала, поэтому сбор идёт заметно дольше." />
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><Users size={14} className="text-spark-400" /> Диапазон участников</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-muted">Минимум
                  <input type="number" min={0} max={MEMBERS_CAP} value={minMembers} onChange={(e) => setMinMembers(e.target.value === '' ? '' : clampMembers(e.target.value))} className="input mt-1 h-9 text-sm" />
                </label>
                <label className="text-xs text-muted">Максимум
                  <input type="number" min={0} max={MEMBERS_CAP} value={maxMembers} onChange={(e) => setMaxMembers(e.target.value === '' ? '' : clampMembers(e.target.value))} className="input mt-1 h-9 text-sm" />
                </label>
              </div>
            </div>

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center justify-between text-sm font-semibold text-fg">
                <span className="flex items-center gap-1.5"><Database size={14} className="text-spark-400" /> Минимальный рейтинг ★</span>
                <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{minRating === 1 ? 'все' : `от ${minRating}/10`}</span>
              </div>
              <input type="range" min={1} max={10} value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} className="w-full accent-spark-500" />
              <p className="mt-1 text-[11px] text-muted">Показывать только каналы/группы с рейтингом ★ ≥ выбранного. «1» — показывать все.</p>
            </div>

            <ToggleRowInline icon={<Radar size={15} />} label="Определение языка" desc="Определять язык канала по постам" checked={langDetect} onChange={setLangDetect} />
          </div>
        </div>
      </SectionCard>
      )}

      {/* Один блок на все модули (правка 19.08): защита и задержки — одно решение.
          У парсера свои поля пауз (между запросами и между каналами), поэтому общий
          TimingSection тут не подходит — но карточка и заголовок те же, что везде. */}
      {cfg.aiProtection && (
        <ProtectionTimings>
          {!fastWork && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
                <Timer size={16} className="text-spark-300" /> Тайминги и задержки
              </div>
              <DelayFields label="Задержка между запросами" from={reqDelay[0]} to={reqDelay[1]} onFrom={(n) => setReqDelay([n, reqDelay[1]])} onTo={(n) => setReqDelay([reqDelay[0], n])} unit="с" />
              <DelayFields label="Задержка между каналами" from={chDelay[0]} to={chDelay[1]} onFrom={(n) => setChDelay([n, chDelay[1]])} onTo={(n) => setChDelay([chDelay[0], n])} unit="с" />
            </div>
          )}
        </ProtectionTimings>
      )}

      {/* Запуск & Логи */}
      {showBlock('run') && (
      <SectionCard id="sec-run" icon={<Play size={18} />} title="Параметры и лимиты">
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          onStart={handleStart}
          onStop={stop}
          onSave={handleSave}
          primaryLabel={cfg.primaryAction ?? 'Начать'}
          steps={!running ? <LaunchSteps steps={markCurrentStep([
            { label: 'Аккаунты', done: selected.size > 0 && busySelectedCount === 0, anchor: 'sec-accounts' },
            { label: 'Ключевые слова', done: keywords.length > 0, anchor: 'sec-settings' },
            { label: 'Запуск', done: false, anchor: 'sec-run' },
          ])} /> : null}
          blockedBy={!running && !canStart ? [
            ...(busySelectedCount ? [`${busySelectedCount} акк. заняты в другом модуле`] : !selected.size ? ['выберите аккаунты'] : []),
            ...(keywords.length ? [] : ['добавьте хотя бы одно ключевое слово']),
          ] : []}
          cost={<LaunchCost compact moduleKey={moduleKey} actions={limit} />}
          stats={launchStats}
          task={task}
          warn={warn}
          presets={presets}
          onApplyPreset={applyPreset}
        />
      </SectionCard>
      )}

      {/* §3.9: расписание доступно и в парсерах — раньше блок жил только в LiveModule
          и все пять парсеров запускались исключительно вручную (тест 6.13). */}
      <SchedulePanel
        moduleKey={moduleKey}
        title={cfg?.title ?? moduleKey}
        buildSettings={() => buildSettings() as unknown as Record<string, unknown>}
        accountIds={[...selected]}
        disabled={!selected.size || !keywords.length}
        disabledReason={!selected.size ? 'Выберите аккаунты' : 'Добавьте хотя бы одно ключевое слово'}
      />

      <div className="flex justify-end">
        <a href={task ? `/panel/tasks?task=${task.id}` : '/panel/tasks'} className="inline-flex items-center gap-1 text-xs font-semibold text-spark-300 hover:underline" title="Логи по этой задаче — в Дашборде задач">
          <Terminal size={13} /> Логи выполнения — в Дашборде задач <ArrowUpRight size={13} />
        </a>
      </div>

      {/* Результаты поиска */}
      <SectionCard icon={<Database size={18} />} title={cfg.resultsTitle ?? 'Результаты поиска'} badge={String(rawResults.length)}>
        {/*
          «Последние запросы» (просьба владельца 26.08): всё, что уже искали, с найденными
          каналами. Стоит в карточке результатов, а не отдельной секцией: это и есть
          результаты — только прошлые. «Открыть» показывает их тем же способом, что и
          «Показать из базы», — состав и дата сбора из кэша.
        */}
        <ParserQueries
          moduleKey={moduleKey}
          unit={isGroups ? 'групп' : 'каналов'}
          onOpen={(rows, q) => {
            setCacheHit({ updatedAt: q.updatedAt, count: rows.length, results: rows })
            setUsingCache(true)
            setCleared(false)
          }}
          onHide={() => setUsingCache(false)}
          extra={cacheHit && !running ? (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted"
              title="Раз в сутки перезапущу этот же поиск, найду новое и отмечу пропавшее. Тратит аккаунты и монеты — как обычный запуск.">
              <input type="checkbox" className="accent-spark-500" checked={watching} disabled={watchBusy} onChange={(e) => void toggleWatch(e.target.checked)} />
              Обновлять раз в сутки
            </label>
          ) : null}
        />

        {/*
          Плашка «в базе есть сохранённый результат» убрана 26.08: она дублировала
          выпадающий список выше — та же дата, тот же счётчик, та же кнопка показа.
          Осталось одно место, где выбирают, что показывать: свежий прогон или сохранённое.
        */}
        {/*
          Вид результатов — общий компонент (правка 27.08). Раньше эта разметка жила только
          здесь, а страница задачи рисовала свою голую таблицу без половины действий.
          Фильтр по рейтингу остаётся снаружи: это настройка ОТБОРА модуля, а не показа.
        */}
        <ParserResultsView
          results={results}
          moduleKey={moduleKey}
          resultLabel={resultLabel}
          isGroups={isGroups}
          onClear={() => setCleared(true)}
        />
      </SectionCard>

    </div>
  )
}

function ToggleRowInline({ icon, label, desc, checked, onChange }: {
  icon: React.ReactNode; label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-line bg-elevated/40 p-3">
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold text-fg"><span className="text-spark-400">{icon}</span> {label}</span>
        {desc && <span className="mt-0.5 block text-[11px] text-muted">{desc}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  )
}
