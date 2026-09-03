/**
 * Результаты парсинга — ОДИН вид на все места, где их показывают.
 *
 * Правка 27.08 (владелец: «формат результатов должен быть как и у парсера внутри, со
 * всеми функциями, которые были для скачек и показа»). Раньше их рисовали двое: карточки
 * с рейтингом, поиском, сортировкой и семью кнопками выгрузки — в самом модуле, и голая
 * таблица «Имя · Юзернейм · Откуда · Тип» — на странице задачи. Одни и те же данные
 * выглядели по-разному, а половина действий на странице задачи просто отсутствовала:
 * скопировать ссылки, сохранить в группу, выгрузить CSV/JSON было нельзя.
 *
 * Здесь же показывается, ПО КАКОМУ КЛЮЧУ найден канал: при десятке слов в запросе без
 * этого не понять, какой ключ приносит мусор.
 */
import { useMemo, useState } from 'react'
import {
  Radar, Users, ExternalLink, Search, Copy, Hash, Download, FolderPlus, Trash2, HelpCircle,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, KeyRound,
} from 'lucide-react'
import { Badge, EmptyState, Select, Tip } from '@/shared/ui'
import { downloadXls } from '@/shared/lib/exportXls'
import { useApp } from '@/mocks/store'
import { SaveToFolderModal } from './shared/FolderPicker'

export interface ParserResult {
  id?: string; title?: string; username?: string; members?: number
  kind?: string; link?: string; hasComments?: boolean
  /** Живые сигналы канала — считает сервер по его постам (26.08). */
  score?: number; lang?: string | null; lastPostAt?: number
  postsPerWeek?: number | null; avgComments?: number | null
  /** По какому ключевому слову канал попал в выдачу (27.08). */
  foundBy?: string
  /** Строка пришла из своей базы, а не из нового обхода Telegram. */
  fromBase?: boolean
}

export function fmtMembers(n: number) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`.replace('.0K', 'K')
  return String(n)
}

/** Эвристический балл качества канала/группы 1–10 (по числу участников + открытые комментарии). */
export function qualityScore(members = 0, hasComments = false): number {
  const tiers = [100000, 50000, 10000, 5000, 1000, 500, 100, 50]
  let s = 2
  for (let i = 0; i < tiers.length; i++) { if (members >= tiers[i]) { s = 10 - i; break } }
  if (hasComments) s = Math.min(10, s + 1)
  return s
}
export function qualityTone(s: number): 'spark' | 'amber' | 'rose' {
  return s >= 7 ? 'spark' : s >= 4 ? 'amber' : 'rose'
}
/** Прозрачная расшифровка балла (§3.8): из чего сложился рейтинг. */
export function qualityExplain(members = 0, hasComments = false): string {
  const tiers: [number, string][] = [
    [100000, '100k+'], [50000, '50k+'], [10000, '10k+'], [5000, '5k+'],
    [1000, '1k+'], [500, '500+'], [100, '100+'], [50, '50+'],
  ]
  let base = 2
  let tierLabel = '<50'
  for (let i = 0; i < tiers.length; i++) { if (members >= tiers[i][0]) { base = 10 - i; tierLabel = tiers[i][1]; break } }
  const bonus = hasComments ? 1 : 0
  const total = Math.min(10, base + bonus)
  return `Подписчиков ${tierLabel} → база ${base}/10${bonus ? '; открытые комментарии +1' : ''} = ${total}/10`
}
export const QUALITY_FORMULA = 'Рейтинг ★/10 = база по числу подписчиков (100k+ → 10, 50k+ → 9, … <50 → 2) + 1 за открытые комментарии.'

export function ParserResultsView({ results: raw, moduleKey, resultLabel, isGroups, onClear, extraActions }: {
  results: ParserResult[]
  moduleKey: string
  /** «канал» / «группа» — подпись на карточке. */
  resultLabel: string
  isGroups?: boolean
  /** Есть — рисуем «Очистить» (в модуле список живой, на странице задачи чистить нечего). */
  onClear?: () => void
  extraActions?: React.ReactNode
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [q, setQ] = useState('')
  const [sortBy, setSortBy] = useState('members-desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [saveFolderOpen, setSaveFolderOpen] = useState(false)

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let r = needle
      ? raw.filter((x) => `${x.title ?? ''} ${x.username ?? ''} ${x.foundBy ?? ''}`.toLowerCase().includes(needle))
      : [...raw]
    r.sort((a, b) => {
      if (sortBy === 'members-desc') return (b.members ?? 0) - (a.members ?? 0)
      if (sortBy === 'members-asc') return (a.members ?? 0) - (b.members ?? 0)
      if (sortBy === 'title-asc') return String(a.title ?? '').localeCompare(String(b.title ?? ''))
      return String(b.title ?? '').localeCompare(String(a.title ?? ''))
    })
    return r
  }, [raw, q, sortBy])

  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const pageResults = results.slice((curPage - 1) * pageSize, curPage * pageSize)

  const copyLinks = () => {
    void navigator.clipboard.writeText(results.map((r) => r.link || (r.username ? `https://t.me/${r.username}` : '')).filter(Boolean).join('\n'))
    pushToast({ type: 'success', title: 'Ссылки скопированы', desc: `${results.length}` })
  }
  const copyIds = () => {
    void navigator.clipboard.writeText(results.map((r) => r.username || r.id).filter(Boolean).join('\n'))
    pushToast({ type: 'success', title: 'ID скопированы', desc: `${results.length}` })
  }
  const exportData = (format: 'json' | 'csv') => {
    let blob: Blob
    if (format === 'json') {
      blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' })
    } else {
      // Ключ в выгрузке тоже нужен: по нему в Excel фильтруют, что принесло какое слово.
      const header = 'title,username,members,link,foundBy\n'
      const rows = results
        .map((r) => `"${String(r.title ?? '').replace(/"/g, '""')}",${r.username ?? ''},${r.members ?? 0},${r.link ?? ''},"${String(r.foundBy ?? '').replace(/"/g, '""')}"`)
        .join('\n')
      blob = new Blob([header + rows], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${moduleKey}-results.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} className="input h-10 pl-9 text-sm" placeholder="Поиск результатов…" />
        </div>
        <Select className="w-48" value={sortBy} onChange={setSortBy} options={[
          { value: 'members-desc', label: 'Участников (больше)' },
          { value: 'members-asc', label: 'Участников (меньше)' },
          { value: 'title-asc', label: 'Название (А-Я)' },
          { value: 'title-desc', label: 'Название (Я-А)' },
        ]} />
        {onClear && (
          <button type="button" onClick={onClear} disabled={!raw.length} className="btn-danger h-10 text-sm disabled:opacity-40"><Trash2 size={15} /> Очистить</button>
        )}
        <button type="button" onClick={copyLinks} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Copy size={15} /> Скопировать ссылки</button>
        <button type="button" onClick={copyIds} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Hash size={15} /> Скопировать ID</button>
        <button type="button" onClick={() => setSaveFolderOpen(true)} disabled={!results.length} className="btn-iris h-10 text-sm disabled:opacity-40"><FolderPlus size={15} /> Сохранить в группу</button>
        <button type="button" onClick={() => exportData('csv')} disabled={!results.length} className="btn-primary h-10 text-sm disabled:opacity-40"><Download size={15} /> Экспорт CSV</button>
        <button type="button" onClick={() => downloadXls(results as unknown as Record<string, unknown>[], `${moduleKey}-results`)} disabled={!results.length} className="btn-soft h-10 text-sm disabled:opacity-40"><Download size={15} /> Excel</button>
        <button type="button" onClick={() => exportData('json')} disabled={!results.length} className="btn-ghost h-10 text-sm disabled:opacity-40"><Download size={15} /> JSON</button>
        {extraActions}
      </div>

      {results.length === 0 ? (
        <EmptyState icon={<Radar size={22} />} title="Результатов пока нет" desc="Запустите парсинг — найденные каналы появятся здесь." />
      ) : (
        <>
          <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-elevated/60 px-3 py-2 text-[11px] leading-snug text-muted">
            <HelpCircle size={13} className="mt-0.5 shrink-0 text-white/40" />
            <span>{QUALITY_FORMULA} Наведите на ★ у результата, чтобы увидеть расчёт для него.</span>
          </div>
          <div className="space-y-2">
            {pageResults.map((r, i) => (
              <div key={(r.username || r.id || i) as string} className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><Radar size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold text-fg">{r.title || '—'}</span>
                    <Badge tone={isGroups ? 'iris' : 'spark'}>{resultLabel}</Badge>
                    {r.hasComments && <Badge tone="muted">💬</Badge>}
                    {r.fromBase && <Tip text="Канал уже был в вашей базе — за ним не ходили в Telegram заново"><Badge tone="muted">из базы</Badge></Tip>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {r.username && <span className="text-iris-300/80">@{r.username}</span>}
                    <span className="inline-flex items-center gap-1"><Users size={11} /> {fmtMembers(r.members ?? 0)}</span>
                    {(() => { const s = r.score ?? qualityScore(r.members ?? 0, r.hasComments); return <Tip text={qualityExplain(r.members ?? 0, r.hasComments)} className="cursor-help"><Badge tone={qualityTone(s)}>★ {s}/10</Badge></Tip> })()}
                    {r.foundBy && (
                      <Tip text="По какому ключевому слову канал попал в выдачу">
                        <span className="inline-flex items-center gap-1 rounded-md bg-spark-500/10 px-1.5 py-0.5 text-[11px] text-spark-300">
                          <KeyRound size={10} /> {r.foundBy}
                        </span>
                      </Tip>
                    )}
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

      <SaveToFolderModal open={saveFolderOpen} onClose={() => setSaveFolderOpen(false)} targets={results.map((r) => r.username || '').filter(Boolean)} />
    </>
  )
}
