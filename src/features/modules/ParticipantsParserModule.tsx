import { useCallback, useMemo, useState } from 'react'
import {
  Play, Users, Settings2, Filter, UserCircle2, Eye, Timer, Zap, Database, Search,
  Copy, Hash, Download, Trash2, ExternalLink, History, MessageCircle, Star, Check, Activity,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Cookie, Loader2, FolderPlus,
} from 'lucide-react'
import { MODULES, type ModuleConfig } from '@/shared/config/modules'
import { activeAccounts, useApp } from '@/mocks/store'
import { Switch, Select, Segmented, Badge, EmptyState, Modal } from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { useModuleTask } from './shared/useModuleTask'
import { SectionCard, NumberField, ProtectionBlock, LaunchPanel } from './shared'
import { cn } from '@/shared/lib/utils'
import { downloadXls } from '@/shared/lib/exportXls'
import { SaveToFolderModal } from './shared/FolderPicker'
import { fetchModuleTasks, fetchModuleTask, type ModuleTaskSettings } from '@/api/modulesApi'
import { fetchTgstatOptions, fetchTgstatSession, fetchTgstatTargets, type TgstatOptions, type TgstatSession } from '@/api/tgstatApi'

/** Стабильные ключи фильтров/лимитов по русским лейблам (для бэкенда). */
const FILTER_KEY: Record<string, string> = {
  'Пропустить ботов': 'skipBots',
  'Пропустить удаленных': 'skipDeleted',
  'Пропустить заблокированных/scam': 'skipScam',
  'Только активные пользователи': 'onlyActive',
  'Только с username': 'onlyUsername',
  'Только с фото': 'onlyPhoto',
  'Только Premium': 'onlyPremium',
  'Собирать только админов': 'onlyAdmins',
  'Включить ответы': 'includeReplies',
  'Включить пересланные сообщения': 'includeForwarded',
  'Сохранять текст комментария': 'keepText',
}
const LIMIT_KEY: Record<string, string> = {
  'Лимит участников': 'participants',
  'Лимит сообщений': 'messages',
  'Фильтр по дням': 'days',
  'Лимит постов': 'posts',
  'Комментариев на пост': 'commentsPerPost',
  'Минимальная длина комментария': 'minCommentLen',
}
const fkey = (label: string) => FILTER_KEY[label] ?? label
const lkey = (label: string) => LIMIT_KEY[label] ?? label

interface UserResult {
  id?: string; name?: string; username?: string; premium?: boolean; role?: string
  messagesCount?: number; groupsCount?: number; firstSeen?: string; lastSeen?: string; kind?: string
}

export function ParticipantsParserModule({ moduleKey }: { moduleKey: string }) {
  const cfg = MODULES[moduleKey]
  if (!cfg?.participants) return null
  return <Inner cfg={cfg} moduleKey={moduleKey} />
}

function Inner({ cfg, moduleKey }: { cfg: ModuleConfig; moduleKey: string }) {
  const P = cfg.participants!
  const accounts = activeAccounts(useApp((s) => s.data))
  const pushToast = useApp((s) => s.pushToast)
  const { task, running, starting, start, stop, savePreset, deletePreset, presets } = useModuleTask(moduleKey)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiProtect, setAiProtect] = useState(false)
  const [protLevel, setProtLevel] = useState(1)
  const [targets, setTargets] = useState('')
  const [keywords, setKeywords] = useState('')
  const [fastWork, setFastWork] = useState(false)
  const [activeStories, setActiveStories] = useState(false)
  const [intersection, setIntersection] = useState(false)
  const [userSource, setUserSource] = useState<'participants' | 'writers'>('participants')

  const [filters, setFilters] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const f of [...P.baseFilters, ...P.profileFilters, ...(P.extraOptions ?? [])]) init[fkey(f.label)] = !!(f as { on?: boolean }).on
    return init
  })
  const [limits, setLimits] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    if (P.unit) init[lkey(P.unit.limitLabel)] = P.unit.limitValue
    for (const l of P.limits ?? []) init[lkey(l.label)] = l.value
    return init
  })
  const [delayChat, setDelayChat] = useState(P.delays[0]?.value ?? 5)
  const [delayItem, setDelayItem] = useState(P.delays[1]?.value ?? 0.5)

  // результаты
  const [resQuery, setResQuery] = useState('')
  const [sortBy, setSortBy] = useState('none')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const [cleared, setCleared] = useState(false)
  const [saveFolderOpen, setSaveFolderOpen] = useState(false)

  const targetList = useMemo(() => targets.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean), [targets])
  const keywordList = useMemo(() => keywords.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean), [keywords])

  const setF = (k: string, v: boolean) => setFilters((s) => ({ ...s, [k]: v }))
  const setL = (k: string, v: number) => setLimits((s) => ({ ...s, [k]: v }))

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds: [...selected],
    targets: targetList,
    keywords: keywordList,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    filters,
    limits,
    activeStories,
    intersectionMode: moduleKey === 'parsing-users' && userSource !== 'writers' ? intersection : false,
    userSource: moduleKey === 'parsing-users' ? userSource : undefined,
    delayChat: fastWork ? 0 : delayChat,
    delayItem: fastWork ? 0 : delayItem,
    limit: limits.participants ?? limits.messages ?? limits.posts ?? 1000,
  }), [selected, targetList, keywordList, aiProtect, protLevel, filters, limits, activeStories, intersection, userSource, fastWork, delayChat, delayItem, moduleKey])

  const busySelectedCount = useMemo(() => [...selected].filter((id) => accounts.some((a) => a.id === id && a.busyIn)).length, [selected, accounts])
  const canStart = selected.size > 0 && busySelectedCount === 0 && targetList.length > 0
  const warn = !canStart ? (busySelectedCount ? `${busySelectedCount} акк. заняты` : !selected.size ? 'Выберите аккаунты' : `Добавьте ${P.sourceTitle.toLowerCase()}`) : undefined

  const loadFromHistory = async () => {
    try {
      const names = new Set<string>()
      for (const k of ['parsing', 'parsing-groups']) {
        const tasks = await fetchModuleTasks(k)
        for (const t of tasks.filter((x) => x.status === 'done').slice(0, 5)) {
          const full = await fetchModuleTask(k, t.id)
          for (const r of full.results || []) { const u = (r as { username?: string }).username; if (u) names.add(String(u)) }
        }
      }
      if (!names.size) return pushToast({ type: 'info', title: 'История пуста', desc: 'Сначала спарсите каналы/группы' })
      setTargets((t) => (t.trim() ? t.trimEnd() + '\n' : '') + [...names].map((u) => `@${u}`).join('\n'))
      pushToast({ type: 'success', title: `Добавлено ${names.size} из истории` })
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }

  const handleStart = () => { setCleared(false); void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`) }
  const handleSave = () => { const n = window.prompt('Название пресета'); if (n?.trim()) void savePreset(n.trim(), buildSettings()) }

  // Цели (targetList) не восстанавливаем — они ситуативны; переносим фильтры, лимиты и задержки.
  const applyPreset = useCallback((s: ModuleTaskSettings) => {
    if (s.aiProtection !== undefined) setAiProtect(s.aiProtection)
    if (s.protectionLevel !== undefined) setProtLevel(s.protectionLevel)
    if (Array.isArray(s.keywords)) setKeywords(s.keywords.join(', '))
    if (s.filters) setFilters((f) => ({ ...f, ...s.filters }))
    if (s.limits) setLimits((l) => ({ ...l, ...s.limits }))
    if (s.activeStories !== undefined) setActiveStories(s.activeStories)
    if (s.delayChat !== undefined) setDelayChat(s.delayChat)
    if (s.delayItem !== undefined) setDelayItem(s.delayItem)
    pushToast({ type: 'success', title: 'Пресет применён' })
  }, [pushToast])

  const logs = task?.logs ?? []
  const raw = (cleared ? [] : (task?.results ?? [])) as UserResult[]
  const results = useMemo(() => {
    let r = raw
    if (resQuery) { const q = resQuery.toLowerCase(); r = r.filter((x) => `${x.name} ${x.username}`.toLowerCase().includes(q)) }
    if (sortBy !== 'none') {
      const [f, d] = sortBy.split('-')
      r = [...r].sort((a, b) => {
        const m = f === 'messages' ? (a.messagesCount ?? 0) - (b.messagesCount ?? 0) : String(a.name).localeCompare(String(b.name))
        return d === 'desc' ? -m : m
      })
    }
    return r
  }, [raw, resQuery, sortBy])

  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const pageRows = results.slice((curPage - 1) * pageSize, curPage * pageSize)

  const copyLinks = () => { void navigator.clipboard.writeText(results.map((r) => r.username ? `https://t.me/${r.username}` : '').filter(Boolean).join('\n')); pushToast({ type: 'success', title: 'Ссылки скопированы', desc: `${results.length}` }) }
  const copyIds = () => { void navigator.clipboard.writeText(results.map((r) => r.username || r.id).filter(Boolean).join('\n')); pushToast({ type: 'success', title: 'ID скопированы', desc: `${results.length}` }) }
  const exportData = (fmt: 'json' | 'csv') => {
    const blob = fmt === 'json'
      ? new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' })
      : new Blob(['id,name,username,premium\n' + results.map((r) => `${r.id ?? ''},"${String(r.name).replace(/"/g, '""')}",${r.username ?? ''},${r.premium ? 1 : 0}`).join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${moduleKey}.${fmt}`; a.click(); URL.revokeObjectURL(url)
    pushToast({ type: 'success', title: `Экспорт .${fmt}`, desc: `${results.length}` })
  }

  const launchStats = [
    { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
    { icon: <MessageCircle size={18} />, color: '#06b6d4', label: P.unit.title, value: String(targetList.length) },
    { icon: <Database size={18} />, color: '#0ec464', label: P.unit.limitLabel, value: String(limits.participants ?? limits.messages ?? limits.posts ?? 1000) },
    { icon: <Filter size={18} />, color: '#f59e0b', label: 'Фильтров', value: String(Object.values(filters).filter(Boolean).length) },
  ]

  return (
    <div className="space-y-4">
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано для парсинга'} />

      <SectionCard icon={<Settings2 size={18} />} title="Настройки парсинга" badge={targetList.length ? `${targetList.length} целей` : undefined}>
        {cfg.aiProtection && <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Левая колонка: источник + ключевые слова + лимиты */}
          <div className="space-y-4">
            {moduleKey === 'parsing-users' && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><Filter size={14} className="text-spark-400" /> Способ сбора</div>
                <Segmented options={['Участники группы', 'Активные (кто писал)']} value={userSource === 'writers' ? 1 : 0} onChange={(i) => setUserSource(i === 1 ? 'writers' : 'participants')} size="sm" />
                {userSource === 'writers' && (
                  <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/8 p-2.5 text-[11px] text-amber-200">
                    <Activity size={13} className="mt-0.5 shrink-0" />
                    <span>Канал → находим чат обсуждения → парсим тех, кто <b>писал</b> (за последние N сообщений), с разбивкой на админ/премиум/обычный. Внимание: чтение большого числа сообщений повышает риск FloodWait/бана — не ставьте лимит слишком высоким и включите защиту.</span>
                  </div>
                )}
              </div>
            )}

            <div>
              <div className="label flex items-center gap-1.5"><MessageCircle size={14} className="text-spark-400" /> {P.sourceTitle}</div>
              <p className="mb-2 text-xs text-muted">{P.sourceHint}</p>
              <textarea value={targets} onChange={(e) => setTargets(e.target.value)} rows={7} className="input resize-none font-mono text-xs" placeholder="@username&#10;https://t.me/group&#10;-1001234567890" />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                {P.formatHint && <span className="text-[11px] text-muted">{P.formatHint}</span>}
                <div className="ml-auto flex flex-wrap gap-2">
                  <TgstatSourceButton onFill={(u) => setTargets((t) => (t.trim() ? t.trimEnd() + '\n' : '') + u.map((x) => `@${x}`).join('\n'))} />
                  {P.historyBtn && <button type="button" onClick={() => void loadFromHistory()} className="btn-soft h-8 text-xs"><History size={13} /> {P.historyBtn}</button>}
                </div>
              </div>
            </div>

            {P.keywords && (
              <div>
                <div className="label flex items-center gap-1.5"><Search size={14} className="text-spark-400" /> {P.keywords.label}</div>
                <p className="mb-1 text-xs text-muted">{P.keywords.hint}</p>
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} className="input h-10 text-sm" placeholder="Слова через запятую…" />
              </div>
            )}

            {(P.limits ?? []).map((l) => (
              <div key={l.label} className="rounded-2xl border border-line bg-elevated/40 p-3">
                <NumberField label={l.label} value={limits[lkey(l.label)] ?? l.value} onChange={(v) => setL(lkey(l.label), v)} />
                {l.hint && <p className="mt-1 text-[11px] text-muted">{l.hint}</p>}
              </div>
            ))}
            {!P.limits && P.unit && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <NumberField label={P.unit.limitLabel} value={limits[lkey(P.unit.limitLabel)] ?? P.unit.limitValue} onChange={(v) => setL(lkey(P.unit.limitLabel), v)} />
                <p className="mt-1 text-[11px] text-muted">Максимум пользователей для парсинга из каждой группы (1–100000)</p>
              </div>
            )}
          </div>

          {/* Правая колонка: быстрая работа + фильтры + доп + задержки */}
          <div className="space-y-3">
            <ToggleRow icon={<Zap size={15} />} label="Быстрая работа" desc="Без задержек между запросами" checked={fastWork} onChange={setFastWork} />

            <div className="grid gap-3 sm:grid-cols-2">
              <FilterCard icon={<Filter size={14} />} title="Базовые фильтры">
                {P.baseFilters.map((f) => <FilterCheck key={f.label} label={f.label} checked={!!filters[fkey(f.label)]} onChange={(v) => setF(fkey(f.label), v)} />)}
              </FilterCard>
              <FilterCard icon={<UserCircle2 size={14} />} title="Фильтры профиля">
                {P.profileFilters.map((f) => <FilterCheck key={f.label} label={f.label} star={f.premium} admin={f.admin} checked={!!filters[fkey(f.label)]} onChange={(v) => setF(fkey(f.label), v)} />)}
              </FilterCard>
            </div>

            {(P.activityFilter || P.extraOptions) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {P.activityFilter && (
                  <FilterCard icon={<Activity size={14} />} title="Фильтры активности">
                    <FilterCheck label="Только активные пользователи" checked={!!filters.onlyActive} onChange={(v) => setF('onlyActive', v)} />
                  </FilterCard>
                )}
                {P.extraOptions && (
                  <FilterCard icon={<Check size={14} />} title="Дополнительные опции">
                    {P.extraOptions.map((f) => <FilterCheck key={f.label} label={f.label} checked={!!filters[fkey(f.label)]} onChange={(v) => setF(fkey(f.label), v)} />)}
                  </FilterCard>
                )}
              </div>
            )}

            {P.activeStories && (
              <ToggleRow icon={<Eye size={15} />} label="Только с активной историей" desc="Оставить только пользователей с активной сторис" checked={activeStories} onChange={setActiveStories} />
            )}

            {moduleKey === 'parsing-users' && (
              <ToggleRow icon={<Users size={15} />} label="Только пересечение групп" desc="Оставить только пользователей, состоящих во ВСЕХ указанных группах (уникальная фича)" checked={intersection} onChange={setIntersection} />
            )}

            {!fastWork && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><Timer size={14} className="text-spark-400" /> Настройки задержек</div>
                <div className="space-y-2">
                  <DelayRow label={P.delays[0]?.label ?? 'Задержка между чатами'} value={delayChat} onChange={setDelayChat} />
                  <DelayRow label={P.delays[1]?.label ?? 'Задержка между пользователями'} value={delayItem} onChange={setDelayItem} step={0.5} />
                </div>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск & Логи'} badge={running ? 'LIVE' : undefined}>
        <LaunchPanel running={running} starting={starting} canStart={canStart} onStart={handleStart} onStop={stop} onSave={handleSave}
          primaryLabel={cfg.primaryAction ?? 'Начать'} stats={launchStats} task={task} warn={warn}
          presets={presets} onApplyPreset={applyPreset} onDeletePreset={deletePreset} />
      </SectionCard>

      <LogsPanel logs={logs} emptyText={cfg.logEmpty ?? 'Логов пока нет'} title="Логи выполнения" live={running} />

      <SectionCard icon={<Database size={18} />} title={cfg.resultsTitle ?? 'Результаты парсинга'} badge={String(raw.length)}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={resQuery} onChange={(e) => { setResQuery(e.target.value); setPage(1) }} className="input h-10 pl-9 text-sm" placeholder="Поиск результатов…" />
          </div>
          <Select className="w-44" value={sortBy} onChange={setSortBy} options={[
            { value: 'none', label: 'Сортировать по…' },
            { value: 'name-asc', label: 'Имя (А-Я)' },
            { value: 'name-desc', label: 'Имя (Я-А)' },
            ...(moduleKey === 'parsing-messages' ? [{ value: 'messages-desc', label: 'Сообщений (больше)' }] : []),
          ]} />
          <button type="button" onClick={() => setCleared(true)} disabled={!raw.length} className="btn-danger h-10 text-sm disabled:opacity-40"><Trash2 size={15} /> Очистить</button>
          <button type="button" onClick={copyLinks} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Copy size={15} /> Скопировать ссылки</button>
          <button type="button" onClick={copyIds} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Hash size={15} /> Скопировать ID</button>
          <button type="button" onClick={() => setSaveFolderOpen(true)} disabled={!results.length} className="btn-iris h-10 text-sm disabled:opacity-40"><FolderPlus size={15} /> Сохранить в папку</button>
          <button type="button" onClick={() => exportData('csv')} disabled={!results.length} className="btn-primary h-10 text-sm disabled:opacity-40"><Download size={15} /> Экспорт CSV</button>
          <button type="button" onClick={() => downloadXls(results as unknown as Record<string, unknown>[], `${moduleKey}-results`)} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Download size={15} /> Excel</button>
          <button type="button" onClick={() => exportData('json')} disabled={!results.length} className="btn-ghost h-10 text-sm disabled:opacity-40"><Download size={15} /> JSON</button>
        </div>

        {results.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="Результатов пока нет" desc="Запустите парсинг — найденные пользователи появятся здесь." />
        ) : (
          <>
            <div className="space-y-2">
              {pageRows.map((r, i) => (
                <div key={(r.username || r.id || i) as string} className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-spark-500/12 text-spark-400"><UserCircle2 size={20} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-fg">{r.name || '—'}</span>
                      {r.premium && <Star size={13} className="shrink-0 text-amber-400" fill="currentColor" />}
                      {r.role === 'admin' ? <Badge tone="iris">АДМИН</Badge> : r.role === 'premium' ? <Badge tone="amber">PREMIUM</Badge> : <Badge tone="spark">ПОЛЬЗОВАТЕЛЬ</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      {r.username ? <span className="text-iris-300/80">@{r.username}</span> : <span>ID: {r.id}</span>}
                      {r.messagesCount != null && <span>· {r.messagesCount} сообщ.</span>}
                      {r.groupsCount != null && <span className="text-spark-300">· в {r.groupsCount} группах</span>}
                    </div>
                  </div>
                  {r.username && <a href={`https://t.me/${r.username}`} target="_blank" rel="noreferrer" className="btn-icon h-9 w-9 shrink-0"><ExternalLink size={15} /></a>}
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

      <SaveToFolderModal open={saveFolderOpen} onClose={() => setSaveFolderOpen(false)} targets={results.map((r) => r.username || '').filter(Boolean)} />
    </div>
  )
}

function ToggleRow({ icon, label, desc, checked, onChange }: { icon: React.ReactNode; label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
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

function FilterCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><span className="text-spark-400">{icon}</span> {title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function FilterCheck({ label, checked, onChange, star, admin }: { label: string; checked: boolean; onChange: (v: boolean) => void; star?: boolean; admin?: boolean }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center gap-2 text-left text-sm text-fg">
      <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', checked ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>{checked && <Check size={11} />}</span>
      <span className="flex items-center gap-1">{label}{star && <Star size={11} className="text-amber-400" fill="currentColor" />}{admin && <Badge tone="iris">admin</Badge>}</span>
    </button>
  )
}

/** Уникальная фича: тянет группы/каналы из каталога TGStat как список целей. */
function TgstatSourceButton({ onFill }: { onFill: (usernames: string[]) => void }) {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState<TgstatOptions | null>(null)
  const [session, setSession] = useState<TgstatSession | null>(null)
  const [category, setCategory] = useState('')
  const [region, setRegion] = useState('ukraine')
  const [minSubs, setMinSubs] = useState<number | ''>(0)
  const [limit, setLimit] = useState<number | ''>(200)
  const [loading, setLoading] = useState(false)

  const openModal = async () => {
    setOpen(true)
    if (!opts) { try { const o = await fetchTgstatOptions(); setOpts(o); if (o.categories[0] && !category) setCategory(o.categories[0].slug) } catch { /* */ } }
    try { setSession(await fetchTgstatSession()) } catch { /* */ }
  }
  const load = async () => {
    if (!category) return pushToast({ type: 'error', title: 'Выберите категорию' })
    setLoading(true)
    try {
      const t = await fetchTgstatTargets({ category, region: region || null, minSubscribers: typeof minSubs === 'number' ? minSubs : 0, maxPages: 1, limit: typeof limit === 'number' && limit > 0 ? limit : 200 })
      const usernames = t.map((x) => x.username).filter(Boolean)
      if (!usernames.length) { pushToast({ type: 'info', title: 'Ничего не найдено', desc: 'Попробуйте другую категорию/регион' }); return }
      onFill(usernames)
      pushToast({ type: 'success', title: `Добавлено ${usernames.length} целей из TGStat` })
      setOpen(false)
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка TGStat', desc: e instanceof Error ? e.message : '' }) } finally { setLoading(false) }
  }

  return (
    <>
      <button type="button" onClick={openModal} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/12 px-2.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/20">
        <Cookie size={13} /> Взять цели из TGStat
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Взять цели из TGStat" subtitle="Каталог TGStat как источник групп/каналов" icon={<Cookie size={22} />} size="sm">
        <div className="space-y-3">
          {session && !session.has_session && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-200">
              TGStat не подключён. Подключите cookies в «Парсер каналов» → вкладка «Парсер каналов TGStat».
            </div>
          )}
          <div>
            <span className="label">Категория</span>
            <Select value={category} onChange={setCategory} placeholder="Выберите категорию" options={(opts?.categories ?? []).map((c) => ({ value: c.slug, label: c.label }))} />
          </div>
          <div>
            <span className="label">Регион</span>
            <Select value={region} onChange={setRegion} options={(opts?.regions ?? []).map((r) => ({ value: r.slug, label: r.label }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted">Мин. подписчиков
              <input type="number" min={0} step={100} value={minSubs} onChange={(e) => setMinSubs(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))} className="input mt-1 h-9 text-sm" />
            </label>
            <label className="text-xs text-muted">Сколько взять
              <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value === "" ? "" : Math.max(1, Math.min(1000, Number(e.target.value))))} className="input mt-1 h-9 text-sm" />
            </label>
          </div>
          <button type="button" onClick={load} disabled={loading || !category || (session ? !session.has_session : false)}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 font-bold text-[#1a1200] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: 'linear-gradient(90deg, #f59e0b, #fbbf24)' }}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Cookie size={16} />} Загрузить цели
          </button>
          <p className="text-center text-[11px] text-muted">Каналы/группы из каталога добавятся в список выше (≈{limit} шт., первая страница ~100/категория).</p>
        </div>
      </Modal>
    </>
  )
}

function DelayRow({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-fg">{label}</span>
      <div className="flex items-center overflow-hidden rounded-lg border border-line bg-elevated">
        <button type="button" onClick={() => onChange(Math.max(0, +(value - step).toFixed(1)))} className="px-2.5 py-1.5 text-muted hover:text-fg">−</button>
        <span className="min-w-[52px] text-center font-mono text-sm font-bold text-fg">{value}s</span>
        <button type="button" onClick={() => onChange(+(value + step).toFixed(1))} className="px-2.5 py-1.5 text-muted hover:text-fg">+</button>
      </div>
    </div>
  )
}
