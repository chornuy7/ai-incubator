import { useCallback, useMemo, useState } from 'react'
import {
  Play, Sparkles, Search, Settings2, Timer, Users, Database, Filter, Radar,
  Plus, X, Trash2, Copy, Hash, Download, ExternalLink, ChevronLeft, ChevronRight,
  ChevronsLeft, ChevronsRight, Bookmark, Zap, SlidersHorizontal, MessageCircle, Check,
} from 'lucide-react'
import { MODULES, LANGUAGES, type ModuleConfig } from '@/shared/config/modules'
import { activeAccounts, useApp } from '@/mocks/store'
import { Segmented, Switch, Badge, Select, EmptyState } from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { useModuleTask } from './shared/useModuleTask'
import { SectionCard, NumberField, ProtectionBlock, DelayFields, LaunchPanel } from './shared'
import { cn } from '@/shared/lib/utils'
import type { ModuleTaskSettings } from '@/api/modulesApi'

/** Словари окончаний для комбинации с ключевыми словами (расширение поиска). */
const ENDINGS: Record<string, string[]> = {
  en: ['chat', 'channel', 'news', 'official', 'group', 'community', 'forum', 'club', 'hub', 'bot', 'shop', 'service', 'store', 'team', 'pro', 'live', 'daily', 'world', 'zone', 'space'],
  ru: ['чат', 'канал', 'новости', 'официальный', 'группа', 'сообщество', 'форум', 'клуб', 'бот', 'магазин', 'сервис', 'мир', 'зона', 'команда', 'про', 'лайв', 'дейли', 'обзор', 'топ', 'инфо'],
  ua: ['чат', 'канал', 'новини', 'офіційний', 'група', 'спільнота', 'форум', 'клуб', 'бот', 'магазин', 'сервіс', 'світ', 'зона', 'команда', 'про', 'лайв', 'дейлі', 'огляд', 'топ', 'інфо'],
}

const LIMIT_CHIPS: (number | '∞')[] = [10, 25, 50, 100, 200, 500, '∞']

interface ParserResult {
  id?: string; title?: string; username?: string; members?: number
  kind?: string; link?: string; hasComments?: boolean
}

function fmtMembers(n: number) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`.replace('.0K', 'K')
  return String(n)
}

export function ChannelParserModule({ moduleKey }: { moduleKey: string }) {
  const cfg = MODULES[moduleKey]
  if (!cfg) return null
  return <ChannelParserInner cfg={cfg} moduleKey={moduleKey} />
}

function ChannelParserInner({ cfg, moduleKey }: { cfg: ModuleConfig; moduleKey: string }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const pushToast = useApp((s) => s.pushToast)
  const { task, running, starting, start, stop, savePreset } = useModuleTask(moduleKey)

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
  const aiKeywords = cfg.aiKeywords ?? []

  // ── окончания ──
  const [endMode, setEndMode] = useState(1) // 0 вручную, 1 авто
  const [endLang, setEndLang] = useState(cfg.endLangDefault ?? 'en')
  const [endCount, setEndCount] = useState(10)
  const [manualEndings, setManualEndings] = useState<string[]>([])
  const [manualEndInput, setManualEndInput] = useState('')

  // ── фильтры / лимиты ──
  const [fastWork, setFastWork] = useState(false)
  const [skipParsed, setSkipParsed] = useState(false)
  const [limit, setLimit] = useState<number | '∞'>(cfg.defaultLimit ?? 50)
  const [activity, setActivity] = useState(cfg.defaultActivity ?? 0)
  const [commentFilter, setCommentFilter] = useState(0)
  const [minComments, setMinComments] = useState(0)
  const [minMembers, setMinMembers] = useState(cfg.defaultMinMembers ?? 100)
  const [maxMembers, setMaxMembers] = useState(100000)
  const [langDetect, setLangDetect] = useState(false)

  // ── задержки ──
  const [reqDelay, setReqDelay] = useState<[number, number]>([2, 2])
  const [chDelay, setChDelay] = useState<[number, number]>([1, 1])

  // ── результаты (вид) ──
  const [resQuery, setResQuery] = useState('')
  const [sortBy, setSortBy] = useState('members-desc')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const [cleared, setCleared] = useState(false)

  const endings = useMemo(() => {
    if (endMode === 0) return manualEndings
    return (ENDINGS[endLang] ?? ENDINGS.en).slice(0, endCount)
  }, [endMode, manualEndings, endLang, endCount])

  const queryCount = keywords.length + keywords.length * endings.length

  const addKeywords = () => {
    const parsed = kwInput.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setKeywords((k) => [...new Set([...k, ...parsed])])
    setKwInput('')
  }
  const addManualEndings = () => {
    const parsed = manualEndInput.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setManualEndings((e) => [...new Set([...e, ...parsed])])
    setManualEndInput('')
  }

  const applyTemplate = (chips: string[]) => {
    setKeywords((k) => [...new Set([...k, ...chips])])
    pushToast({ type: 'success', title: 'Шаблон применён', desc: `+${chips.length} ключевых слов` })
  }

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds: [...selected],
    keywords,
    endings,
    searchMode: method,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    resultLimit: limit === '∞' ? 0 : limit,
    limit: limit === '∞' ? 0 : limit,
    activityFilter: activity,
    commentFilter,
    minComments,
    minMembers,
    maxMembers,
    langDetection: langDetect,
    delays: {
      request: fastWork ? [0, 0] : reqDelay,
      channel: fastWork ? [0, 0] : chDelay,
      floodWait: 120,
      floodQuarantine: 3,
    },
  }), [selected, keywords, endings, method, aiProtect, protLevel, limit, activity, commentFilter, minComments, minMembers, maxMembers, langDetect, fastWork, reqDelay, chDelay])

  const busySelectedCount = useMemo(
    () => [...selected].filter((id) => accounts.some((a) => a.id === id && a.busyIn)).length,
    [selected, accounts],
  )
  const canStart = selected.size > 0 && busySelectedCount === 0 && keywords.length > 0
  const warn = !canStart
    ? (busySelectedCount ? `${busySelectedCount} акк. заняты в другом модуле` : !selected.size ? 'Выберите аккаунты' : 'Добавьте хотя бы одно ключевое слово')
    : undefined

  const handleStart = () => { setCleared(false); void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`) }
  const handleSave = () => { const name = window.prompt('Название шаблона настроек'); if (name?.trim()) void savePreset(name.trim(), buildSettings()) }

  const logs = task?.logs ?? []
  const rawResults = (cleared ? [] : (task?.results ?? [])) as ParserResult[]

  const results = useMemo(() => {
    let r = rawResults
    if (resQuery) {
      const q = resQuery.toLowerCase()
      r = r.filter((x) => `${x.title} ${x.username}`.toLowerCase().includes(q))
    }
    const [field, dir] = sortBy.split('-')
    r = [...r].sort((a, b) => {
      const m = field === 'members' ? (a.members ?? 0) - (b.members ?? 0) : String(a.title).localeCompare(String(b.title))
      return dir === 'desc' ? -m : m
    })
    return r
  }, [rawResults, resQuery, sortBy])

  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const pageResults = results.slice((curPage - 1) * pageSize, curPage * pageSize)

  const copyLinks = () => {
    const text = results.map((r) => r.link || (r.username ? `https://t.me/${r.username}` : '')).filter(Boolean).join('\n')
    void navigator.clipboard.writeText(text)
    pushToast({ type: 'success', title: 'Ссылки скопированы', desc: `${results.length}` })
  }
  const copyIds = () => {
    const text = results.map((r) => r.username || r.id).filter(Boolean).join('\n')
    void navigator.clipboard.writeText(text)
    pushToast({ type: 'success', title: 'ID скопированы', desc: `${results.length}` })
  }
  const exportData = (format: 'json' | 'csv') => {
    let blob: Blob
    if (format === 'json') {
      blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' })
    } else {
      const header = 'title,username,members,link\n'
      const rows = results.map((r) => `"${String(r.title).replace(/"/g, '""')}",${r.username ?? ''},${r.members ?? 0},${r.link ?? ''}`).join('\n')
      blob = new Blob([header + rows], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${moduleKey}-results.${format}`
    a.click()
    URL.revokeObjectURL(url)
    pushToast({ type: 'success', title: `Экспорт .${format}`, desc: `${results.length} записей` })
  }

  const launchStats = [
    { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
    { icon: <Search size={18} />, color: '#06b6d4', label: 'Ключевые слова', value: String(keywords.length) },
    { icon: <Hash size={18} />, color: '#0ec464', label: 'Запросов', value: String(queryCount) },
    { icon: <Database size={18} />, color: '#f59e0b', label: 'Макс. результатов', value: limit === '∞' ? '∞' : String(limit) },
  ]

  return (
    <div className="space-y-4">
      {/* Выбор аккаунтов */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано для парсинга'} />

      {/* Шаблоны */}
      {cfg.templates && cfg.templates.length > 0 && (
        <SectionCard icon={<Bookmark size={18} />} title={cfg.templatesTitle ?? 'Шаблоны'} badge={cfg.templatesBadge}>
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
        </SectionCard>
      )}

      {/* Настройки поиска */}
      <SectionCard icon={<Settings2 size={18} />} title="Настройки поиска" badge={`${keywords.length} ключевых слов`}>
        {cfg.aiProtection && <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />}

        <div className="mb-4">
          <Segmented options={cfg.methodTabs?.slice(0, 2) ?? ['Поиск по ключевым словам', 'Похожие каналы']} value={method} onChange={setMethod} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Левая колонка: ключевые слова + окончания */}
          <div className="space-y-4">
            <div>
              <div className="label flex items-center gap-1.5"><Search size={14} /> Ключевые слова *</div>
              <div className="flex gap-2">
                <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKeywords()} className="input h-10 text-sm" placeholder="Слова через запятую…" />
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

            {aiKeywords.length > 0 && (
              <div className="rounded-2xl border border-iris-500/25 bg-iris-500/8 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-iris-300"><Sparkles size={14} /> ИИ-предложенные ключевые слова</div>
                <div className="flex flex-wrap gap-2">
                  {aiKeywords.map((a) => (
                    <button key={a.w} type="button" disabled={keywords.includes(a.w)} onClick={() => setKeywords((k) => [...new Set([...k, a.w])])}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1 text-xs text-fg hover:border-iris-500/40 disabled:opacity-40">
                      {a.w} <span className="rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-300">{a.p}%</span>
                      <Plus size={12} className="text-iris-300" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-fg"><Bookmark size={14} className="text-spark-400" /> Окончания</span>
                <Segmented size="sm" options={['Вручную', 'Авто']} value={endMode} onChange={setEndMode} />
              </div>
              {endMode === 1 ? (
                <div className="space-y-3">
                  <Select value={endLang} onChange={setEndLang} options={LANGUAGES.map((l) => ({ value: l.code, label: `${l.flag} ${l.label}` }))} />
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-muted"><span>Количество окончаний</span><span className="rounded bg-elevated px-1.5 font-bold text-spark-300">{endCount}</span></div>
                    <input type="range" min={5} max={20} value={endCount} onChange={(e) => setEndCount(Number(e.target.value))} className="w-full accent-spark-500" />
                    <div className="flex justify-between text-[10px] text-faint"><span>Быстро (5)</span><span>Тщательно (20)</span></div>
                  </div>
                  <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] text-muted">{endCount} окончаний × {keywords.length} слов = <b className="text-spark-300">{queryCount}</b> поисковых запросов</div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input value={manualEndInput} onChange={(e) => setManualEndInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManualEndings()} className="input h-9 text-sm" placeholder="Окончания через запятую…" />
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
            <ToggleRowInline icon={<Filter size={15} />} label="Не собирать уже спарсенные" desc="Вырежем каналы из истории парсинга" checked={skipParsed} onChange={setSkipParsed} />

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><Database size={14} className="text-spark-400" /> Лимит результатов</div>
              <div className="flex flex-wrap gap-1.5">
                {LIMIT_CHIPS.map((c) => (
                  <button key={String(c)} type="button" onClick={() => setLimit(c)} className={cn('rounded-lg border px-3 py-1.5 text-sm font-bold transition-colors', limit === c ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}>{c}</button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><SlidersHorizontal size={14} className="text-spark-400" /> Фильтр активности</div>
              <Segmented size="sm" options={['Любая активность', 'Только активные', 'Неактивные']} value={activity} onChange={setActivity} />
            </div>

            {cfg.commentFilter && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><MessageCircle size={14} className="text-spark-400" /> Фильтр комментариев</div>
                <Segmented size="sm" options={['Любые', 'Только открытые', 'Только закрытые']} value={commentFilter} onChange={setCommentFilter} />
                <div className="mt-3">
                  <NumberField label="Мин. комментариев на пост" value={minComments} onChange={setMinComments} />
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><Users size={14} className="text-spark-400" /> Диапазон участников</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-muted">Минимум
                  <input type="number" value={minMembers} onChange={(e) => setMinMembers(Number(e.target.value))} className="input mt-1 h-9 text-sm" />
                </label>
                <label className="text-xs text-muted">Максимум
                  <input type="number" value={maxMembers} onChange={(e) => setMaxMembers(Number(e.target.value))} className="input mt-1 h-9 text-sm" />
                </label>
              </div>
            </div>

            <ToggleRowInline icon={<Radar size={15} />} label="Определение языка" desc="Определять язык канала по постам" checked={langDetect} onChange={setLangDetect} />
          </div>
        </div>
      </SectionCard>

      {/* Задержки */}
      {!fastWork && (
        <SectionCard icon={<Timer size={18} />} title="Настройки задержек">
          <DelayFields label="Задержка между запросами" from={reqDelay[0]} to={reqDelay[1]} onFrom={(n) => setReqDelay([n, reqDelay[1]])} onTo={(n) => setReqDelay([reqDelay[0], n])} unit="с" />
          <DelayFields label="Задержка между каналами" from={chDelay[0]} to={chDelay[1]} onFrom={(n) => setChDelay([n, chDelay[1]])} onTo={(n) => setChDelay([chDelay[0], n])} unit="с" />
        </SectionCard>
      )}

      {/* Запуск & Логи */}
      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск & Логи'} badge={running ? 'LIVE' : undefined}>
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          onStart={handleStart}
          onStop={stop}
          onSave={handleSave}
          primaryLabel={cfg.primaryAction ?? 'Запустить парсинг'}
          stats={launchStats}
          task={task}
          warn={warn}
        />
      </SectionCard>

      <LogsPanel logs={logs} emptyText={cfg.logEmpty ?? 'Логов пока нет'} title="Логи выполнения" live={running} />

      {/* Результаты поиска */}
      <SectionCard icon={<Database size={18} />} title={cfg.resultsTitle ?? 'Результаты поиска'} badge={String(rawResults.length)}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={resQuery} onChange={(e) => { setResQuery(e.target.value); setPage(1) }} className="input h-10 pl-9 text-sm" placeholder="Поиск результатов…" />
          </div>
          <Select className="w-48" value={sortBy} onChange={setSortBy} options={[
            { value: 'members-desc', label: 'Участников (больше)' },
            { value: 'members-asc', label: 'Участников (меньше)' },
            { value: 'title-asc', label: 'Название (А-Я)' },
            { value: 'title-desc', label: 'Название (Я-А)' },
          ]} />
          <button type="button" onClick={() => setCleared(true)} disabled={!rawResults.length} className="btn-danger h-10 text-sm disabled:opacity-40"><Trash2 size={15} /> Очистить</button>
          <button type="button" onClick={copyLinks} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Copy size={15} /> Скопировать ссылки</button>
          <button type="button" onClick={copyIds} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Hash size={15} /> Скопировать ID</button>
          <button type="button" onClick={() => exportData('csv')} disabled={!results.length} className="btn-primary h-10 text-sm disabled:opacity-40"><Download size={15} /> Экспорт CSV</button>
          <button type="button" onClick={() => exportData('json')} disabled={!results.length} className="btn-ghost h-10 text-sm disabled:opacity-40"><Download size={15} /> JSON</button>
        </div>

        {results.length === 0 ? (
          <EmptyState icon={<Radar size={22} />} title="Результатов пока нет" desc="Запустите парсинг — найденные каналы появятся здесь." />
        ) : (
          <>
            <div className="space-y-2">
              {pageResults.map((r, i) => (
                <div key={(r.username || r.id || i) as string} className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><Radar size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-fg">{r.title || '—'}</span>
                      <Badge tone={isGroups ? 'iris' : 'spark'}>{resultLabel}</Badge>
                      {r.hasComments && <Badge tone="muted">💬</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      {r.username && <span className="text-iris-300/80">@{r.username}</span>}
                      <span className="inline-flex items-center gap-1"><Users size={11} /> {fmtMembers(r.members ?? 0)}</span>
                    </div>
                  </div>
                  {r.link && (
                    <a href={r.link} target="_blank" rel="noreferrer" className="btn-icon h-9 w-9 shrink-0" title="Открыть в Telegram"><ExternalLink size={15} /></a>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
              <span>Показано {(curPage - 1) * pageSize + 1}–{Math.min(curPage * pageSize, results.length)} из {results.length}</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPage(1)} disabled={curPage === 1} className="btn-icon h-8 w-8 disabled:opacity-30"><ChevronsLeft size={15} /></button>
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={curPage === 1} className="btn-icon h-8 w-8 disabled:opacity-30"><ChevronLeft size={15} /></button>
                <span className="px-2 font-mono text-xs">{curPage} / {totalPages}</span>
                <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={curPage === totalPages} className="btn-icon h-8 w-8 disabled:opacity-30"><ChevronRight size={15} /></button>
                <button type="button" onClick={() => setPage(totalPages)} disabled={curPage === totalPages} className="btn-icon h-8 w-8 disabled:opacity-30"><ChevronsRight size={15} /></button>
              </div>
              <label className="flex items-center gap-2">На странице:
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="rounded-lg border border-line bg-elevated px-2 py-1 text-fg">
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          </>
        )}
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
