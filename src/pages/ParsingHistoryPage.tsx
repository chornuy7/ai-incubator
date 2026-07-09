import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Calendar, Eraser, Download, Eye, Loader2, CheckCircle2, XCircle, Radio, Users, Search, MessageCircle, Hash, Database, Check, RefreshCw } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Modal, Badge, Skeleton } from '@/shared/ui'
import { compact, cn } from '@/shared/lib/utils'
import { fetchParsingHistory, fetchHistoryResults, type HistoryItem } from '@/api/parsingHistoryApi'

const MODULES_FILTER = ['Все модули', 'Каналы', 'Группы', 'Пользователи', 'Сообщения', 'Комментарии', 'TGStat']
const STATUS_FILTER = [
  { value: 'all', label: 'Все статусы' },
  { value: 'done', label: 'Завершено' },
  { value: 'running', label: 'Выполняется' },
  { value: 'error', label: 'Ошибка' },
]
const STATUS_META = {
  done: { label: 'Завершено', tone: 'spark' as const, icon: <CheckCircle2 size={13} /> },
  running: { label: 'Выполняется', tone: 'iris' as const, icon: <Loader2 size={13} className="animate-spin" /> },
  error: { label: 'Ошибка', tone: 'rose' as const, icon: <XCircle size={13} /> },
}
const MODULE_ICON: Record<string, React.ReactNode> = {
  Каналы: <Radio size={13} />, Группы: <Users size={13} />, Пользователи: <Users size={13} />,
  Сообщения: <MessageCircle size={13} />, Комментарии: <Hash size={13} />, TGStat: <Database size={13} />,
}

function fmtDate(ts: number) {
  const d = new Date(ts)
  return {
    day: d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
  }
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'entity')
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return '﻿' + keys.join(',') + '\n' + rows.map((r) => keys.map((k) => esc(r[k])).join(',')).join('\n')
}

export function ParsingHistoryPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [module, setModule] = useState('Все модули')
  const [status, setStatus] = useState('all')
  const [date, setDate] = useState('')
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<HistoryItem | null>(null)
  const [detailRows, setDetailRows] = useState<Record<string, unknown>[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setItems(await fetchParsingHistory()) } catch { /* API недоступен */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  // авто-обновление, пока есть выполняющиеся
  const hasRunning = items.some((i) => i.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [hasRunning, load])

  const filtered = useMemo(
    () => items.filter((h) =>
      (module === 'Все модули' || h.moduleLabel === module) &&
      (status === 'all' || h.status === status) &&
      (!date || new Date(h.date).toISOString().slice(0, 10) === date) &&
      (!kw || h.keywords.join(' ').toLowerCase().includes(kw.toLowerCase()))),
    [items, module, status, date, kw],
  )

  const openDetail = async (h: HistoryItem) => {
    setDetail(h); setDetailRows(null)
    try { setDetailRows(await fetchHistoryResults(h)) } catch { setDetailRows([]) }
  }

  const download = async (h: HistoryItem) => {
    setBusyId(h.id)
    try {
      const rows = await fetchHistoryResults(h)
      if (!rows.length) { pushToast({ type: 'info', title: 'Нет результатов для экспорта' }); return }
      const blob = new Blob([toCsv(rows)], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `${h.moduleKey}-${h.id}.csv`; a.click(); URL.revokeObjectURL(url)
      pushToast({ type: 'success', title: 'Экспорт CSV', desc: `${rows.length} записей` })
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка экспорта', desc: e instanceof Error ? e.message : '' }) } finally { setBusyId(null) }
  }

  return (
    <div>
      <PageHeader
        title="История парсинга"
        subtitle="Просмотр и управление историей всех запусков парсеров"
        icon={<History size={22} />}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => { setLoading(true); void load() }} className="btn-ghost h-10"><RefreshCw size={15} /> Обновить</button>
            <div className="flex flex-col items-center rounded-2xl border border-iris-500/40 bg-iris-500/8 px-5 py-2 leading-tight">
              <span className="font-display text-2xl font-bold text-iris-300">{items.length}</span>
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Всего</span>
            </div>
          </div>
        }
      />

      <Card className="mb-4 border-dashed p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div><span className="label">Выберите модуль</span><Select value={module} onChange={setModule} options={MODULES_FILTER.map((m) => ({ value: m, label: m }))} /></div>
          <div><span className="label">Выберите статус</span><Select value={status} onChange={setStatus} options={STATUS_FILTER} /></div>
          <div>
            <span className="label">Диапазон дат</span>
            <div className="relative"><Calendar size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input h-10 pl-9" /></div>
          </div>
          <div>
            <span className="label">Поиск по ключевым словам</span>
            <div className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={kw} onChange={(e) => setKw(e.target.value)} className="input h-10 pl-9" placeholder="Поиск по ключевым словам" /></div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => pushToast({ type: 'info', title: 'Фильтры применены', desc: `Найдено записей: ${filtered.length}` })} className="btn-primary h-10"><Check size={15} /> Применить</button>
          <button onClick={() => { setModule('Все модули'); setStatus('all'); setDate(''); setKw('') }} className="btn-ghost h-10"><Eraser size={15} /> Очистить</button>
        </div>
      </Card>

      {loading ? (
        <Card className="space-y-3"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></Card>
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<History size={26} />} title="История пуста" desc="Запуски парсеров появятся здесь после первого прогона." /></Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-elevated/60 text-left text-[11px] font-bold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-4 py-3">Модуль</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Ключевые слова</th>
                  <th className="px-4 py-3 text-right">Найдено</th>
                  <th className="px-4 py-3 text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((h) => {
                  const m = STATUS_META[h.status]
                  const d = fmtDate(h.date)
                  return (
                    <tr key={h.id} className="border-b border-line/50 last:border-0 hover:bg-elevated/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-muted"><Calendar size={14} /> <span className="font-mono text-xs">{d.day}<br /><span className="text-faint">{d.time}</span></span></div>
                      </td>
                      <td className="px-4 py-3"><span className="inline-flex items-center gap-1.5 rounded-lg bg-iris-500/12 px-2.5 py-1 text-xs font-bold text-iris-300">{MODULE_ICON[h.moduleLabel]} {h.moduleLabel}</span></td>
                      <td className="px-4 py-3"><span className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', h.status === 'done' ? 'text-spark-300' : h.status === 'error' ? 'text-rose-300' : 'text-iris-300')}>{m.icon} {m.label}</span></td>
                      <td className="px-4 py-3">
                        {h.keywords.length === 0 ? <span className="text-faint">—</span> : (
                          <div className="flex flex-wrap items-center gap-1">
                            {h.keywords.slice(0, 2).map((c) => <span key={c} className="rounded-md bg-elevated px-2 py-0.5 text-xs text-fg">{c}</span>)}
                            {h.keywords.length > 2 && <span className="rounded-md bg-iris-500/12 px-1.5 py-0.5 text-xs font-bold text-iris-300">+{h.keywords.length - 2}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right"><span className="inline-flex items-center gap-1 font-mono font-bold text-spark-300"><CheckCircle2 size={13} /> {compact(h.found)}</span></td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => void openDetail(h)} className="btn-icon h-8 w-8 text-iris-300" title="Просмотр"><Eye size={14} /></button>
                          <button onClick={() => void download(h)} disabled={busyId === h.id || h.found === 0} className="btn-icon h-8 w-8 text-spark-300 disabled:opacity-40" title="Скачать CSV">{busyId === h.id ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={!!detail} onClose={() => { setDetail(null); setDetailRows(null) }} title="Детали задачи парсинга" subtitle={detail?.moduleLabel} icon={<Database size={22} />} size="md">
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {[['Дата', fmtDate(detail.date).day + ' ' + fmtDate(detail.date).time], ['Модуль', detail.moduleLabel], ['Найдено', compact(detail.found)], ['Ключевые слова', detail.keywords.join(', ') || '—']].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">{k}</div><div className="mt-0.5 font-semibold text-fg">{v}</div></div>
              ))}
            </div>
            <div className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">Статус</div><div className="mt-1"><Badge tone={STATUS_META[detail.status].tone}>{STATUS_META[detail.status].icon} {STATUS_META[detail.status].label}</Badge></div></div>

            <div className="rounded-xl border border-line bg-elevated p-3">
              <div className="mb-2 text-xs text-muted">Результаты {detailRows ? `(${detailRows.length})` : ''}</div>
              {!detailRows ? (
                <div className="flex justify-center py-4"><Loader2 className="animate-spin text-muted" /></div>
              ) : detailRows.length === 0 ? (
                <div className="py-2 text-sm text-muted">Нет сохранённых результатов.</div>
              ) : (
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {detailRows.slice(0, 50).map((r, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs">
                      <span className="truncate text-fg">{String(r.chat_name ?? r.title ?? r.name ?? r.username ?? r.id ?? '—')}</span>
                      <span className="shrink-0 text-muted">{r.chat_username ? `@${r.chat_username}` : r.username ? `@${r.username}` : ''} {String(r.subscribers ?? r.members ?? '')}</span>
                    </div>
                  ))}
                  {detailRows.length > 50 && <div className="pt-1 text-center text-[11px] text-faint">…и ещё {detailRows.length - 50}</div>}
                </div>
              )}
            </div>

            <button onClick={() => void download(detail)} disabled={detail.found === 0} className="btn-primary h-10 w-full disabled:opacity-40"><Download size={15} /> Экспортировать результаты (CSV)</button>
          </div>
        )}
      </Modal>
    </div>
  )
}
