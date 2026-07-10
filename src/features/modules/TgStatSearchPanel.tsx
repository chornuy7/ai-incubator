import { useEffect, useMemo, useState } from 'react'
import {
  Search, SlidersHorizontal, Loader2, Users, ExternalLink, Copy, Hash, Download, FolderPlus, Cookie,
} from 'lucide-react'
import { useApp } from '@/mocks/store'
import { Select, Badge, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { downloadXls } from '@/shared/lib/exportXls'
import { SaveToFolderModal } from './shared/FolderPicker'
import {
  fetchTgstatOptions, fetchTgstatSession, searchTgstatChannels,
  type TgstatOptions, type TgstatSession, type TgstatChat, type TgstatSearchFilters,
} from '@/api/tgstatApi'

const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0)

function NumField({ label, value, onChange, placeholder }: { label: string; value: number | ''; onChange: (v: number | '') => void; placeholder?: string }) {
  return (
    <label className="text-xs text-muted">{label}
      <input type="number" min={0} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
        className="input mt-1 h-9 text-sm" />
    </label>
  )
}

function CheckPill({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={cn('rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
        checked ? 'border-amber-500/50 bg-amber-500/12 text-amber-200' : 'border-line bg-elevated text-muted hover:text-fg')}>
      {label}
    </button>
  )
}

/** Расширенный поиск каналов TGStat с фильтрами (охват/ER/ИЦ/аудитория/verified и т.д.). */
export function TgStatSearchPanel() {
  const pushToast = useApp((s) => s.pushToast)
  const [options, setOptions] = useState<TgstatOptions | null>(null)
  const [session, setSession] = useState<TgstatSession | null>(null)

  const [q, setQ] = useState('')
  const [inAbout, setInAbout] = useState(false)
  const [category, setCategory] = useState('')
  const [subFrom, setSubFrom] = useState<number | ''>(1000)
  const [subTo, setSubTo] = useState<number | ''>('')
  const [reachFrom, setReachFrom] = useState<number | ''>('')
  const [er, setEr] = useState<number | ''>('')
  const [ci, setCi] = useState<number | ''>('')
  const [age, setAge] = useState<number | ''>('')
  const [flags, setFlags] = useState<Record<string, boolean>>({ noScam: true, noDead: true })
  const [sort, setSort] = useState('participants')
  const [maxPages, setMaxPages] = useState(3)

  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<TgstatChat[]>([])
  const [saveFolderOpen, setSaveFolderOpen] = useState(false)

  useEffect(() => {
    void fetchTgstatOptions().then(setOptions).catch(() => {})
    void fetchTgstatSession().then(setSession).catch(() => {})
  }, [])

  const setFlag = (k: string, v: boolean) => setFlags((s) => ({ ...s, [k]: v }))
  const ready = session?.has_session === true

  const filters = useMemo<TgstatSearchFilters>(() => ({
    q: q.trim() || undefined,
    inAbout: inAbout || undefined,
    categories: category ? [category] : undefined,
    participantsCountFrom: subFrom === '' ? undefined : subFrom,
    participantsCountTo: subTo === '' ? undefined : subTo,
    avgReachFrom: reachFrom === '' ? undefined : reachFrom,
    er: er === '' ? undefined : er,
    ciFrom: ci === '' ? undefined : ci,
    age: age === '' ? undefined : age,
    isVerified: flags.isVerified || undefined,
    isStoriesAvailable: flags.isStoriesAvailable || undefined,
    isRknVerified: flags.isRknVerified || undefined,
    noRedLabel: flags.noRedLabel || undefined,
    noScam: flags.noScam || undefined,
    noDead: flags.noDead || undefined,
    sort,
  }), [q, inAbout, category, subFrom, subTo, reachFrom, er, ci, age, flags, sort])

  const runSearch = async () => {
    if (!ready) return pushToast({ type: 'error', title: 'Подключите TGStat', desc: 'Загрузите cookies во вкладке TGStat' })
    if (!q.trim() && !category) return pushToast({ type: 'error', title: 'Укажите ключевое слово или категорию' })
    setLoading(true)
    try {
      const chats = await searchTgstatChannels(filters, maxPages)
      setResults(chats)
      pushToast({ type: chats.length ? 'success' : 'info', title: `Найдено ${chats.length} каналов` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка поиска', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }

  const links = results.map((c) => c.chat_link || (c.chat_username ? `https://t.me/${c.chat_username}` : '')).filter(Boolean)
  const usernames = results.map((c) => c.chat_username || '').filter(Boolean)
  const copy = (arr: string[], title: string) => { void navigator.clipboard.writeText(arr.join('\n')); pushToast({ type: 'success', title, desc: `${arr.length}` }) }
  const exportCsv = () => {
    const header = 'chat_name,chat_username,subscribers,chat_link\n'
    const rows = results.map((c) => `"${String(c.chat_name).replace(/"/g, '""')}",${c.chat_username ?? ''},${c.subscribers ?? 0},${c.chat_link ?? ''}`).join('\n')
    const blob = new Blob(['﻿' + header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'tgstat-search.csv'; a.click(); URL.revokeObjectURL(url)
    pushToast({ type: 'success', title: 'Экспорт CSV', desc: `${results.length}` })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-500/30 bg-surface shadow-card">
        <div className="flex items-center gap-3 border-b border-amber-500/20 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/12 text-amber-300"><SlidersHorizontal size={18} /></span>
          <span className="font-display text-base font-bold text-fg">Расширенный поиск TGStat</span>
          {ready ? <Badge tone="spark">Подключён</Badge> : <Badge tone="amber"><Cookie size={12} /> Нужны cookies</Badge>}
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <label className="label">Ключевое слово</label>
              <div className="flex gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void runSearch()} className="input h-10 text-sm" placeholder="crypto, новости, массаж…" />
              </div>
              <div className="mt-1.5"><CheckPill label="Искать и в описании" checked={inAbout} onChange={setInAbout} /></div>
            </div>
            <div>
              <label className="label">Категория (опц.)</label>
              <Select value={category} onChange={setCategory} placeholder="Любая категория"
                options={[{ value: '', label: 'Любая категория' }, ...(options?.categories ?? []).map((c) => ({ value: c.slug, label: c.label }))]} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumField label="Подписчиков от" value={subFrom} onChange={setSubFrom} />
            <NumField label="Подписчиков до" value={subTo} onChange={setSubTo} />
            <NumField label="Средний охват от" value={reachFrom} onChange={setReachFrom} />
            <NumField label="ER (%) от" value={er} onChange={setEr} />
            <NumField label="Индекс цитирования (ИЦ) от" value={ci} onChange={setCi} />
            <NumField label="Возраст канала (мес.) до" value={age} onChange={setAge} />
            <div>
              <label className="label">Сортировка</label>
              <Select value={sort} onChange={setSort} options={[
                { value: 'participants', label: 'По подписчикам' },
                { value: 'avg_reach', label: 'По охвату' },
                { value: 'ci', label: 'По ИЦ' },
              ]} />
            </div>
            <NumField label="Сколько страниц (×~30)" value={maxPages} onChange={(v) => setMaxPages(typeof v === 'number' ? Math.max(1, Math.min(20, v)) : 3)} />
          </div>

          <div>
            <label className="label">Дополнительно</label>
            <div className="flex flex-wrap gap-2">
              <CheckPill label="Verified" checked={!!flags.isVerified} onChange={(v) => setFlag('isVerified', v)} />
              <CheckPill label="Доступны сторис" checked={!!flags.isStoriesAvailable} onChange={(v) => setFlag('isStoriesAvailable', v)} />
              <CheckPill label="Без SCAM/FAKE" checked={!!flags.noScam} onChange={(v) => setFlag('noScam', v)} />
              <CheckPill label="Без «мёртвых»" checked={!!flags.noDead} onChange={(v) => setFlag('noDead', v)} />
              <CheckPill label="Без красной метки" checked={!!flags.noRedLabel} onChange={(v) => setFlag('noRedLabel', v)} />
              <CheckPill label="В РКН" checked={!!flags.isRknVerified} onChange={(v) => setFlag('isRknVerified', v)} />
            </div>
          </div>

          <button type="button" onClick={() => void runSearch()} disabled={loading || !ready}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3 font-bold text-[#1a1200] transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: 'linear-gradient(90deg, #f59e0b, #fbbf24)' }}>
            {loading ? <Loader2 size={17} className="animate-spin" /> : <Search size={17} />} Найти каналы
          </button>
          {!ready && <p className="text-center text-xs text-amber-300">Сначала подключите TGStat (вкладка «Парсер каналов TGStat» → загрузить cookies).</p>}
        </div>
      </div>

      {/* Результаты */}
      <div className="rounded-2xl border border-amber-500/30 bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/12 text-amber-300"><Search size={18} /></span>
          <span className="font-display text-base font-bold text-fg">Результаты</span>
          <span className="rounded-md bg-amber-500/12 px-2 py-0.5 text-xs font-bold text-amber-300">{results.length}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" onClick={() => copy(links, 'Ссылки скопированы')} disabled={!results.length} className="btn-soft h-9 text-xs disabled:opacity-40"><Copy size={14} /> Ссылки</button>
            <button type="button" onClick={() => copy(usernames, 'ID скопированы')} disabled={!results.length} className="btn-soft h-9 text-xs disabled:opacity-40"><Hash size={14} /> ID</button>
            <button type="button" onClick={() => setSaveFolderOpen(true)} disabled={!results.length} className="btn-iris h-9 text-xs disabled:opacity-40"><FolderPlus size={14} /> В папку</button>
            <button type="button" onClick={exportCsv} disabled={!results.length} className="btn-primary h-9 text-xs disabled:opacity-40"><Download size={14} /> CSV</button>
            <button type="button" onClick={() => downloadXls(results as unknown as Record<string, unknown>[], 'tgstat-search')} disabled={!results.length} className="btn-soft h-9 text-xs disabled:opacity-40"><Download size={14} /> Excel</button>
          </div>
        </div>
        <div className="p-4">
          {results.length === 0 ? (
            <EmptyState icon={<Search size={22} />} title="Результатов пока нет" desc="Задайте фильтры и нажмите «Найти каналы»." />
          ) : (
            <div className="max-h-[32rem] space-y-2 overflow-y-auto">
              {results.map((c) => (
                <div key={c.chat_username || c.chat_link} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 p-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/12 text-amber-300"><Users size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-fg">{c.chat_name || '—'}</div>
                    <div className="text-xs text-muted">{c.chat_username && <span className="text-iris-300/80">@{c.chat_username}</span>} · {fmt(c.subscribers)} подп.</div>
                  </div>
                  <a href={c.chat_link} target="_blank" rel="noreferrer" className="btn-icon h-9 w-9 shrink-0" title="Открыть в Telegram"><ExternalLink size={15} /></a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <SaveToFolderModal open={saveFolderOpen} onClose={() => setSaveFolderOpen(false)} targets={usernames} />
    </div>
  )
}
