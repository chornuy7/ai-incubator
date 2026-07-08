import { useMemo, useState } from 'react'
import {
  BarChart3, Download, MessageSquareText, Sparkles, MessagesSquare, Eye, Send, Users, FileSpreadsheet, FileJson, ChevronRight,
} from 'lucide-react'
import { useApp, activeAccounts } from '@/mocks/store'
import { useMockLoading } from '@/shared/lib/hooks'
import { PageHeader, Segmented, Tabs, Card, EmptyState, Avatar, StatusBadge, Dropdown, MenuItem, Skeleton } from '@/shared/ui'
import { BarChart } from '@/shared/ui/BarChart'
import { compact } from '@/shared/lib/utils'

const RANGES = ['Сегодня', 'Неделя', 'Месяц', 'За всё время']
const RANGE_MUL = [0.16, 1, 3.4, 9.2]

const KPIS = [
  { key: 'comments', label: 'Комментарии', icon: MessageSquareText, color: '#0ec464' },
  { key: 'reactions', label: 'Реакции', icon: Sparkles, color: '#7145ff' },
  { key: 'messages', label: 'Сообщения', icon: MessagesSquare, color: '#06b6d4' },
  { key: 'views', label: 'Просмотры', icon: Eye, color: '#f59e0b' },
  { key: 'pm', label: 'ЛС-рассылка', icon: Send, color: '#ec4899' },
] as const

export function StatisticsPage() {
  const data = useApp((s) => s.data)
  const pushToast = useApp((s) => s.pushToast)
  const [range, setRange] = useState(1)
  const [tab, setTab] = useState('dashboard')
  const loading = useMockLoading(600, [range, tab])

  const mul = RANGE_MUL[range]
  const stats = data.stats
  const hasData = stats.comments + stats.reactions + stats.messages + stats.views > 0

  const scaledSeries = useMemo(
    () => stats.series.map((p) => ({
      label: p.label,
      comments: Math.round(p.comments * (range === 0 ? 0.2 : 1)),
      reactions: Math.round(p.reactions * (range === 0 ? 0.2 : 1)),
      messages: Math.round(p.messages * (range === 0 ? 0.2 : 1)),
    })),
    [stats.series, range],
  )

  const exportBtn = (
    <Dropdown
      width={200}
      trigger={({ toggle }) => <button onClick={toggle} className="btn-ghost h-10"><Download size={16} /> Экспорт</button>}
    >
      {(close) => (
        <>
          <MenuItem icon={<FileSpreadsheet size={15} />} onClick={() => { exportCsv(data, pushToast); close() }}>Скачать CSV</MenuItem>
          <MenuItem icon={<FileJson size={15} />} onClick={() => { pushToast({ type: 'success', title: 'Экспорт JSON', desc: 'stats.json (демо).' }); close() }}>Скачать JSON</MenuItem>
        </>
      )}
    </Dropdown>
  )

  return (
    <div>
      <PageHeader
        title="Моя статистика"
        subtitle="Активность аккаунтов и модулей"
        icon={<BarChart3 size={22} />}
        actions={<>
          <Segmented options={RANGES} value={range} onChange={setRange} size="sm" />
          {exportBtn}
        </>}
      />

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'dashboard', label: 'Дашборд' },
          { key: 'accounts', label: 'Аккаунты' },
          { key: 'history', label: 'История' },
        ]}
      />

      {!hasData ? (
        <Card><EmptyState icon={<BarChart3 size={26} />} title="Данные отсутствуют" desc="Запустите модули — статистика появится здесь." /></Card>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          <Skeleton className="col-span-full h-72 rounded-2xl" />
        </div>
      ) : tab === 'dashboard' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {KPIS.map((k) => {
              const value = Math.round((stats[k.key] as number) * mul)
              return (
                <Card key={k.key} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: `${k.color}20`, color: k.color }}><k.icon size={18} /></div>
                    <span className="text-xs font-semibold text-spark-300">+{(8 + (RANGES.indexOf(RANGES[range]) + 1) * 3)}%</span>
                  </div>
                  <div className="mt-3 stat-value">{compact(value)}</div>
                  <div className="text-xs font-medium text-muted">{k.label}</div>
                </Card>
              )
            })}
          </div>

          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="section-title">Активность за период</h3>
              <span className="text-xs text-muted">{RANGES[range]}</span>
            </div>
            <BarChart
              data={scaledSeries}
              categoryKey="label"
              series={[
                { key: 'comments', label: 'Комментарии', color: '#0ec464' },
                { key: 'reactions', label: 'Реакции', color: '#7145ff' },
                { key: 'messages', label: 'Сообщения', color: '#06b6d4' },
              ]}
            />
          </Card>
        </div>
      ) : tab === 'accounts' ? (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-elevated/60 text-left text-[11px] font-bold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3">Аккаунт</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3 text-right">Коммент.</th>
                  <th className="px-4 py-3 text-right">Реакции</th>
                  <th className="px-4 py-3 text-right">Сообщ.</th>
                  <th className="px-4 py-3 text-right">Просмотры</th>
                </tr>
              </thead>
              <tbody>
                {activeAccounts(data).map((a, i) => (
                  <tr key={a.id} className="border-b border-line/50 last:border-0 hover:bg-elevated/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={a.name} color={a.avatarColor} size={32} />
                        <div><div className="font-semibold text-fg">{a.name}</div><div className="text-xs text-muted">@{a.username}</div></div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                    <td className="px-4 py-3 text-right font-mono text-fg">{Math.round((120 + i * 37) * mul)}</td>
                    <td className="px-4 py-3 text-right font-mono text-fg">{Math.round((45 + i * 12) * mul)}</td>
                    <td className="px-4 py-3 text-right font-mono text-fg">{Math.round((30 + i * 9) * mul)}</td>
                    <td className="px-4 py-3 text-right font-mono text-fg">{compact(Math.round((980 + i * 210) * mul))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {stats.history.map((h) => (
            <Card key={h.key} className="flex items-center justify-between p-4 transition-colors hover:border-spark-500/30">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-elevated text-spark-400"><Users size={18} /></div>
                <div>
                  <div className="font-semibold text-fg">{h.label}</div>
                  <div className="text-xs text-muted">записей: {compact(Math.round(h.count * mul))}</div>
                </div>
              </div>
              <button onClick={() => pushToast({ type: 'info', title: h.label, desc: 'Детальная лента — в демо только заголовок.' })} className="btn-icon h-8 w-8"><ChevronRight size={16} /></button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function exportCsv(data: ReturnType<typeof useApp.getState>['data'], pushToast: (t: { type: 'success'; title: string; desc?: string }) => void) {
  const rows = [['День', 'Комментарии', 'Реакции', 'Сообщения', 'Просмотры'], ...data.stats.series.map((p) => [p.label, p.comments, p.reactions, p.messages, p.views])]
  const csv = rows.map((r) => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'ai-incubator-stats.csv'; a.click()
  URL.revokeObjectURL(url)
  pushToast({ type: 'success', title: 'CSV скачан', desc: 'ai-incubator-stats.csv' })
}
