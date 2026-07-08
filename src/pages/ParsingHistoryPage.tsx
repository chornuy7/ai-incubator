import { useMemo, useState } from 'react'
import { History, Calendar, Eraser, Download, Eye, Loader2, CheckCircle2, XCircle, Radio, Users, Search, MessageCircle, Hash, Database, Check } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { useMockLoading } from '@/shared/lib/hooks'
import { PageHeader, Card, EmptyState, Select, Modal, Badge, Skeleton } from '@/shared/ui'
import { compact, cn } from '@/shared/lib/utils'
import type { ParsingHistoryItem } from '@/shared/types'

const MODULES_FILTER = ['Все модули', 'Парсер каналов', 'Парсер групп', 'Парсер пользователей', 'Парсер по сообщениям', 'Парсер комментариев']
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
const MODULE_META: Record<string, { short: string; icon: React.ReactNode }> = {
  'Парсер каналов': { short: 'Каналы', icon: <Radio size={13} /> },
  'Парсер групп': { short: 'Группы', icon: <Users size={13} /> },
  'Парсер пользователей': { short: 'Пользователи', icon: <Users size={13} /> },
  'Парсер по сообщениям': { short: 'Сообщения', icon: <MessageCircle size={13} /> },
  'Парсер комментариев': { short: 'Комментарии', icon: <Hash size={13} /> },
}

export function ParsingHistoryPage() {
  const history = useApp((s) => s.data.parsingHistory)
  const pushToast = useApp((s) => s.pushToast)
  const [module, setModule] = useState('Все модули')
  const [status, setStatus] = useState('all')
  const [date, setDate] = useState('')
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<ParsingHistoryItem | null>(null)
  const loading = useMockLoading(500, [])

  const filtered = useMemo(
    () => history.filter((h) =>
      (module === 'Все модули' || h.module === module) &&
      (status === 'all' || h.status === status) &&
      (!kw || h.keywords.toLowerCase().includes(kw.toLowerCase()))),
    [history, module, status, kw],
  )

  return (
    <div>
      <PageHeader
        title="История парсинга"
        subtitle="Просмотр и управление историей всех запусков парсеров"
        icon={<History size={22} />}
        actions={
          <div className="flex flex-col items-center rounded-2xl border border-iris-500/40 bg-iris-500/8 px-5 py-2 leading-tight">
            <span className="font-display text-2xl font-bold text-iris-300">{history.length}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Всего</span>
          </div>
        }
      />

      {/* Filters */}
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
          <button onClick={() => pushToast({ type: 'success', title: 'Экспорт CSV (демо)' })} className="btn-ghost ml-auto h-10"><Download size={15} /> Экспорт</button>
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
                  const mod = MODULE_META[h.module]
                  const chips = h.keywords ? h.keywords.split(',').map((k) => k.trim()).filter(Boolean) : []
                  return (
                    <tr key={h.id} className="border-b border-line/50 last:border-0 hover:bg-elevated/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-muted"><Calendar size={14} /> <span className="font-mono text-xs">{h.date.split(' ')[0]}<br /><span className="text-faint">{h.date.split(' ')[1]}</span></span></div>
                      </td>
                      <td className="px-4 py-3"><span className="inline-flex items-center gap-1.5 rounded-lg bg-iris-500/12 px-2.5 py-1 text-xs font-bold text-iris-300">{mod?.icon} {mod?.short ?? h.module}</span></td>
                      <td className="px-4 py-3"><span className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', h.status === 'done' ? 'text-spark-300' : h.status === 'error' ? 'text-rose-300' : 'text-iris-300')}>{m.icon} {m.label}</span></td>
                      <td className="px-4 py-3">
                        {chips.length === 0 ? <span className="text-faint">—</span> : (
                          <div className="flex flex-wrap items-center gap-1">
                            {chips.slice(0, 2).map((c) => <span key={c} className="rounded-md bg-elevated px-2 py-0.5 text-xs text-fg">{c}</span>)}
                            {chips.length > 2 && <span className="rounded-md bg-iris-500/12 px-1.5 py-0.5 text-xs font-bold text-iris-300">+{chips.length - 2}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right"><span className="inline-flex items-center gap-1 font-mono font-bold text-spark-300"><CheckCircle2 size={13} /> {compact(h.found)}</span></td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => setDetail(h)} className="btn-icon h-8 w-8 text-iris-300"><Eye size={14} /></button>
                          <button onClick={() => pushToast({ type: 'success', title: 'Результаты экспортированы (демо)', desc: h.module })} className="btn-icon h-8 w-8 text-spark-300"><Download size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-center gap-1 border-t border-line py-3">
            <button className="btn-icon h-8 w-8">«</button><button className="btn-icon h-8 w-8">‹</button>
            <span className="h-8 w-8 rounded-lg bg-spark-gradient text-center text-sm font-bold leading-8 text-[#04150c]">1</span>
            <button className="btn-icon h-8 w-8">›</button><button className="btn-icon h-8 w-8">»</button>
          </div>
        </Card>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Детали задачи парсинга" subtitle={detail?.module} icon={<Database size={22} />} size="md">
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {[['Дата', detail.date], ['Модуль', detail.module], ['Найдено', compact(detail.found)], ['Ключевые слова', detail.keywords || '—']].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">{k}</div><div className="mt-0.5 font-semibold text-fg">{v}</div></div>
              ))}
            </div>
            <div className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">Статус</div><div className="mt-1"><Badge tone={STATUS_META[detail.status].tone}>{STATUS_META[detail.status].icon} {STATUS_META[detail.status].label}</Badge></div></div>
            <button onClick={() => pushToast({ type: 'success', title: 'Результаты экспортированы (демо)' })} className="btn-primary h-10 w-full"><Download size={15} /> Экспортировать результаты</button>
          </div>
        )}
      </Modal>
    </div>
  )
}
