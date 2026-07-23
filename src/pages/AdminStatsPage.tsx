import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Users, ListChecks, Coins, Download, RefreshCw } from 'lucide-react'
import { PageHeader, Card, Segmented, EmptyState } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { fetchAdminOverview, fetchClientReport, type AdminOverview, type ClientReport } from '@/api/adminApi'

/**
 * §5.3 (E1/E2): админ-панель со статистикой и постатейный отчёт клиенту.
 *
 * Два экрана намеренно на одной странице: числа в отчёте и числа в панели должны
 * совпадать, а собираются они одним запросом на сервере — расхождение «инвойса»
 * с тем, что видит оператор, здесь худшее из возможного.
 */

const PERIODS = [
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
]

const STATUS_RU: Record<string, string> = {
  active: 'Активные', working: 'В работе', warming: 'Прогрев', pause: 'На паузе',
  floodwait: 'FloodWait', quarantine: 'Карантин', spamblock: 'Спамблок',
  invalid: 'Невалидные', reauth: 'Реавторизация', frozen: 'Отключены',
  done: 'Готово', running: 'Выполняется', stopped: 'Остановлены', queued: 'В очереди', error: 'Ошибка', paused: 'Пауза',
}

const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n))
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('ru-RU')

export function AdminStatsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [tab, setTab] = useState(0)
  const [periodIdx, setPeriodIdx] = useState(1)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [report, setReport] = useState<ClientReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)

  const since = useMemo(() => Date.now() - PERIODS[periodIdx].days * 24 * 60 * 60 * 1000, [periodIdx])

  const load = async () => {
    setLoading(true)
    try {
      const [o, r] = await Promise.all([fetchAdminOverview(since), fetchClientReport(since)])
      setOverview(o); setReport(r); setDenied(false)
    } catch (e) {
      // 403 — не ошибка сборки, а честный отказ: показываем это отдельно, иначе
      // оператор будет думать, что страница сломалась.
      const msg = e instanceof Error ? e.message : ''
      if (/администратор/i.test(msg)) setDenied(true)
      else pushToast({ type: 'error', title: 'Не удалось загрузить статистику', desc: msg })
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [since])

  /** Выгрузка «инвойса» в CSV — клиенту его нужно отправить, а не показать на экране. */
  const exportCsv = () => {
    if (!report?.rows.length) return
    const head = ['Модуль', 'Задач', 'Завершено', 'Действий', 'Токенов', 'Монет']
    const lines = [
      `Отчёт за период ${fmtDate(report.since)} — ${fmtDate(report.until)}`,
      head.join(';'),
      ...report.rows.map((r) => [r.title, r.tasks, r.completed, r.actions, r.tokens, r.coins].join(';')),
      ['ИТОГО', report.totals.tasks, '', report.totals.actions, report.totals.tokens, report.totals.coins].join(';'),
    ]
    // BOM — иначе Excel открывает кириллицу кракозябрами, и отчёт клиенту нечитаем.
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `otchet-${fmtDate(report.since)}-${fmtDate(report.until)}.csv`.replace(/\./g, '-')
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (denied) {
    return (
      <div>
        <PageHeader title="Статистика" subtitle="Сводка по системе и отчёт клиенту (§5.3)" icon={<BarChart3 size={22} />} />
        <Card className="p-6">
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="Доступно только администратору"
            desc="Здесь данные по всем пользователям и деньгам, поэтому раздел закрыт для остальных ролей."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Статистика"
        subtitle="Сводка по системе и постатейный отчёт клиенту (§5.3)"
        icon={<BarChart3 size={22} />}
        actions={
          <button onClick={() => void load()} className="btn-ghost h-10" disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Обновить
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented options={['Панель', 'Отчёт клиенту']} value={tab} onChange={setTab} />
        <Segmented options={PERIODS.map((p) => p.label)} value={periodIdx} onChange={setPeriodIdx} size="sm" />
      </div>

      {loading && !overview ? (
        <Card className="p-6 text-sm text-muted">Загрузка…</Card>
      ) : tab === 0 ? (
        <PanelTab o={overview} />
      ) : (
        <ReportTab report={report} onExport={exportCsv} />
      )}
    </div>
  )
}

function Tile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">{icon} {label}</div>
      <div className="font-display text-2xl font-bold text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  )
}

function Breakdown({ title, data, ru }: { title: string; data: Record<string, number>; ru?: boolean }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (!rows.length) return null
  const max = rows[0][1] || 1
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-semibold text-fg">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-xs text-muted">{ru ? (STATUS_RU[k] || k) : k}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
              <div className="h-full rounded-full bg-spark-500/70" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{fmt(v)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function PanelTab({ o }: { o: AdminOverview | null }) {
  if (!o) return <Card className="p-6 text-sm text-muted">Нет данных</Card>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={<Users size={14} />} label="Аккаунты" value={fmt(o.accounts.total)}
          hint={`${o.accounts.resting} отдыхают · ${o.accounts.tired} устают`}
        />
        <Tile icon={<ListChecks size={14} />} label="Задач за период" value={fmt(o.tasks.total)} />
        <Tile
          icon={<Coins size={14} />} label="Израсходовано" value={`${fmt(o.tokens.tokens)} ток.`}
          hint={`${o.tokens.coins} монет · ${fmt(o.tokens.calls)} запросов к ИИ`}
        />
        <Tile
          icon={<Coins size={14} />} label="Баланс" value={o.balance ? `${o.balance.coins}` : '—'}
          hint={o.balance ? `Тариф «${o.balance.plan.name}» · до ${o.balance.plan.accountLimit} акк.` : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Breakdown title="Аккаунты по статусам" data={o.accounts.byStatus} ru />
        <Breakdown title="Задачи по статусам" data={o.tasks.byStatus} ru />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Breakdown title="Токены по модулям" data={o.tokens.byModule} />
        <Breakdown title="Действия в журнале" data={o.audit.byAction} />
      </div>

      <Card className="p-4">
        <div className="text-sm text-muted">
          Пользователей в системе: <b className="text-fg">{o.users.total}</b> ({o.users.active} активных).
          Записей в журнале за период: <b className="text-fg">{fmt(o.audit.total)}</b>.
        </div>
      </Card>
    </div>
  )
}

function ReportTab({ report, onExport }: { report: ClientReport | null; onExport: () => void }) {
  if (!report || !report.rows.length) {
    return (
      <Card className="p-6">
        <EmptyState icon={<BarChart3 size={22} />} title="За период работ не было" desc="Выберите другой период — отчёт строится по задачам модулей." />
      </Card>
    )
  }
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-fg">
          Отчёт за {fmtDate(report.since)} — {fmtDate(report.until)}
        </div>
        <button onClick={onExport} className="btn-ghost ml-auto h-9 text-sm"><Download size={15} /> Выгрузить CSV</button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Постатейно: строка на модуль. Детали отдельных действий — в логах задач, здесь только итоги.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="pb-2 pr-3 font-medium">Модуль</th>
              <th className="pb-2 pr-3 text-right font-medium">Задач</th>
              <th className="pb-2 pr-3 text-right font-medium">Завершено</th>
              <th className="pb-2 pr-3 text-right font-medium">Действий</th>
              <th className="pb-2 pr-3 text-right font-medium">Токенов</th>
              <th className="pb-2 text-right font-medium">Монет</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.moduleKey} className="border-b border-line/50">
                <td className="py-2 pr-3 text-fg">{r.title}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tasks)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.completed)}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-fg">{fmt(r.actions)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tokens)}</td>
                <td className="py-2 text-right tabular-nums text-amber-300">{r.coins || '—'}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-2 pr-3 text-fg">ИТОГО</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tasks)}</td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.actions)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tokens)}</td>
              <td className="py-2 text-right tabular-nums text-amber-300">{report.totals.coins || '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}
