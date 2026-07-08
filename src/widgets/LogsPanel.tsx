import { useMemo, useState } from 'react'
import { Terminal, ArrowUp, Download, Search, Trash2 } from 'lucide-react'
import type { LogEntry, LogLevel } from '@/shared/types'
import { LOG_LEVEL_META, useApp } from '@/mocks/store'
import { EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'

type Filter = 'all' | LogLevel

export function LogsPanel({ logs, emptyText, title = 'Логи', live = false }: { logs: LogEntry[]; emptyText: string; title?: string; live?: boolean }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const pushToast = useApp((s) => s.pushToast)

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: logs.length, info: 0, success: 0, warning: 0, error: 0 }
    for (const l of logs) c[l.level] += 1
    return c
  }, [logs])

  const filtered = (filter === 'all' ? logs : logs.filter((l) => l.level === filter))
    .filter((l) => !query || `${l.message} ${l.account ?? ''}`.toLowerCase().includes(query.toLowerCase()))

  const TABS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'Все' },
    { key: 'info', label: 'Info' },
    { key: 'success', label: 'Успех' },
    { key: 'warning', label: 'Предупр.' },
    { key: 'error', label: 'Ошибки' },
  ]

  return (
    <div className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold text-fg">
          <Terminal size={16} className="text-spark-400" /> {title}
          {live && <span className="inline-flex items-center gap-1 rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-spark-300"><span className="h-1.5 w-1.5 rounded-full bg-spark-400 animate-pulse" /> LIVE</span>}
          <span className="rounded-md bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted">{logs.length}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
                filter === t.key ? 'bg-spark-500/12 text-spark-300' : 'text-muted hover:text-fg',
              )}
            >
              {t.label} {counts[t.key]}
            </button>
          ))}
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-32 rounded-lg border border-line bg-elevated pl-7 pr-2 text-xs text-fg placeholder:text-faint focus:outline-none" placeholder="Поиск логов…" />
          </div>
          <button onClick={() => pushToast({ type: 'success', title: 'Логи экспортированы', desc: 'logs.txt (демо).' })} className="btn-icon h-7 w-7" title="Экспорт"><Download size={14} /></button>
          <button onClick={() => pushToast({ type: 'info', title: 'Логи очищены (демо)' })} className="btn-icon h-7 w-7" title="Очистить"><Trash2 size={14} /></button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={<Terminal size={24} />} title="Логов нет" desc={emptyText} />
      ) : (
        <div className="log-scroll relative">
          {filtered.map((l) => {
            const m = LOG_LEVEL_META[l.level]
            return (
              <div key={l.id} className="flex items-start gap-2.5 border-b border-line/50 py-1.5 last:border-0">
                <span className="shrink-0 text-faint">{l.ts}</span>
                <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', m.dot)} />
                <span className={cn('shrink-0 font-bold uppercase', m.color)}>{m.label}</span>
                {l.account && <span className="shrink-0 text-iris-300/80">{l.account}</span>}
                <span className="min-w-0 flex-1 text-muted">{l.message}</span>
              </div>
            )
          })}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-line px-4 py-2">
        <span className="text-xs text-muted">Показано {filtered.length} из {logs.length}</span>
        <button className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg" onClick={() => {}}>
          <ArrowUp size={13} /> Наверх
        </button>
      </div>
    </div>
  )
}
