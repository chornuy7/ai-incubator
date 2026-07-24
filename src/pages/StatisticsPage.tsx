import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3, Download, MessageSquareText, Sparkles, MessagesSquare, Eye, Send, Users, FileSpreadsheet, FileJson, ChevronRight, ChevronDown,
  Coins, ListChecks, Wallet, RefreshCw, ArrowDownRight, ArrowUpRight,
} from 'lucide-react'
import { useApp, activeAccounts } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { useMockLoading } from '@/shared/lib/hooks'
import { PageHeader, Segmented, Tabs, Card, EmptyState, Avatar, StatusBadge, Dropdown, MenuItem, Skeleton } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { BarChart } from '@/shared/ui/BarChart'
import { compact, coins as fmtCoins, cn } from '@/shared/lib/utils'
import { fetchMyStats, type MyStats } from '@/api/meApi'
import { fetchWalletHistory, type WalletEntry } from '@/api/balanceApi'

const RANGES = ['Сегодня', 'Неделя', 'Месяц', 'За всё время']
/** Дней в периоде; 0 — «всё время» (since уходит в 0). Зеркалит периоды админ-панели. */
const RANGE_DAYS = [1, 7, 30, 0]

/** Роды активности — те же, что раньше рисовались моком; теперь из реальных действий задач. */
const KPIS = [
  { key: 'comments', label: 'Комментарии', icon: MessageSquareText, color: '#0ec464' },
  { key: 'reactions', label: 'Реакции', icon: Sparkles, color: '#7145ff' },
  { key: 'messages', label: 'Сообщения', icon: MessagesSquare, color: '#06b6d4' },
  { key: 'views', label: 'Просмотры', icon: Eye, color: '#f59e0b' },
  { key: 'pm', label: 'ЛС-рассылка', icon: Send, color: '#ec4899' },
] as const

/**
 * «Статистика» — ЛИЧНЫЙ кабинет: своя активность и свои расходы, без чужих данных.
 *
 * Раньше страница показывала красивые, но выдуманные числа (моки). Теперь при
 * сессии тянет реальный срез по себе (§5.3, /api/me/stats): активность по родам
 * действий, расход, разрез «куда идёт работа», ленту запусков и кошелёк. Данных,
 * которые касаются других людей или денег пространства, здесь нет — они в
 * админ-панели. Демо без сессии по-прежнему показывает моки: там показывать нечего.
 */
export function StatisticsPage() {
  const sessionUser = useSession((s) => s.user)
  return sessionUser ? <MyStatistics /> : <DemoStatistics />
}

const fmtInt = (n: number) => compact(Math.round(n || 0))

function MyStatistics() {
  const pushToast = useApp((s) => s.pushToast)
  const [range, setRange] = useState(2)
  const [tab, setTab] = useState('dashboard')
  const [stats, setStats] = useState<MyStats | null>(null)
  const [loading, setLoading] = useState(true)

  const since = useMemo(() => {
    const d = RANGE_DAYS[range]
    return d ? Date.now() - d * 24 * 60 * 60 * 1000 : 0
  }, [range])

  const load = async () => {
    setLoading(true)
    try {
      setStats(await fetchMyStats(since))
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось загрузить статистику', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [since]) // eslint-disable-line react-hooks/exhaustive-deps

  const a = stats?.activity
  const hasActivity = !!a && (a.comments + a.reactions + a.messages + a.views + a.pm) > 0
  const hasData = !!stats && (hasActivity || stats.totals.tasks > 0 || stats.totals.spent > 0)

  const chartData = useMemo(
    () => (stats?.daily || [])
      .filter((d) => d.comments + d.reactions + d.messages > 0)
      .map((d) => ({ label: d.day.slice(5), comments: d.comments, reactions: d.reactions, messages: d.messages })),
    [stats?.daily],
  )

  const exportBtn = (
    <Dropdown
      width={200}
      trigger={({ toggle }) => <button onClick={toggle} className="btn-ghost h-10" disabled={!stats}><Download size={16} /> Экспорт</button>}
    >
      {(close) => (
        <>
          <MenuItem icon={<FileSpreadsheet size={15} />} onClick={() => { if (stats) exportMyCsv(stats, pushToast); close() }}>Скачать CSV</MenuItem>
          <MenuItem icon={<FileJson size={15} />} onClick={() => { pushToast({ type: 'success', title: 'Экспорт JSON', desc: 'my-stats.json (демо).' }); close() }}>Скачать JSON</MenuItem>
        </>
      )}
    </Dropdown>
  )

  return (
    <div>
      <PageHeader
        title="Статистика"
        subtitle="Моя активность и расходы"
        icon={<BarChart3 size={22} />}
        actions={<>
          <HelpButton topic="my-statistics" className="h-10 w-10" />
          <button onClick={() => void load()} className="btn-ghost h-10 w-10 px-0" disabled={loading} title="Обновить"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
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
          { key: 'log', label: 'Запуски' },
          { key: 'wallet', label: 'Кошелёк' },
        ]}
      />

      {loading && !stats ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          <Skeleton className="col-span-full h-72 rounded-2xl" />
        </div>
      ) : tab === 'wallet' ? (
        <WalletTab coins={stats?.coins ?? 0} />
      ) : tab === 'log' ? (
        <LogTab log={stats?.log || []} />
      ) : !hasData ? (
        <Card><EmptyState icon={<BarChart3 size={26} />} title="Данные отсутствуют" desc="Запустите модули — ваша статистика появится здесь." /></Card>
      ) : (
        <div className="space-y-4">
          {/* Активность по родам действий — реальные цифры из задач модулей. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {KPIS.map((k) => (
              <Card key={k.key} className="p-4">
                <div className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: `${k.color}20`, color: k.color }}><k.icon size={18} /></div>
                <div className="mt-3 stat-value">{fmtInt(a ? a[k.key] : 0)}</div>
                <div className="text-xs font-medium text-muted">{k.label}</div>
              </Card>
            ))}
          </div>

          {/* Свои деньги и объём работы — то, что раньше было только в админке по каждому. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MoneyTile icon={<Wallet size={16} />} label="На счету" value={`${fmtCoins(stats!.coins)} ⚡`} accent="text-fg" />
            <MoneyTile icon={<Coins size={16} />} label="Списано за период" value={`${fmtCoins(stats!.totals.spent)} ⚡`} accent="text-amber-300" />
            <MoneyTile icon={<ListChecks size={16} />} label="Задач" value={fmtInt(stats!.totals.tasks)} hint={`${fmtInt(stats!.totals.actions)} действий`} />
            <MoneyTile icon={<Sparkles size={16} />} label="Токенов ИИ" value={fmtInt(stats!.totals.tokens)} />
          </div>

          {chartData.length > 0 && (
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="section-title">Активность за период</h3>
                <span className="text-xs text-muted">{RANGES[range]}</span>
              </div>
              <BarChart
                data={chartData}
                categoryKey="label"
                series={[
                  { key: 'comments', label: 'Комментарии', color: '#0ec464' },
                  { key: 'reactions', label: 'Реакции', color: '#7145ff' },
                  { key: 'messages', label: 'Сообщения', color: '#06b6d4' },
                ]}
              />
            </Card>
          )}

          {!!stats!.where.length && <WhereCard where={stats!.where} />}
        </div>
      )}
    </div>
  )
}

function MoneyTile({ icon, label, value, hint, accent }: { icon: React.ReactNode; label: string; value: string; hint?: string; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">{icon} {label}</div>
      <div className={cn('font-display text-2xl font-bold', accent || 'text-fg')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  )
}

/** «Куда идёт работа» — разрез по модулям: где именно тратятся действия и монеты. */
function WhereCard({ where }: { where: MyStats['where'] }) {
  const max = Math.max(...where.map((w) => w.actions), 1)
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-semibold text-fg">Куда идёт работа</div>
      <div className="flex flex-col gap-2">
        {where.map((w) => (
          <div key={w.moduleKey} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-xs text-muted">{w.title}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
              <div className="h-full rounded-full bg-spark-500/70" style={{ width: `${Math.max(3, (w.actions / max) * 100)}%` }} />
            </div>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-fg">
              {compact(w.actions)} действ.
              {w.spent ? <span className="text-amber-300"> · {fmtCoins(w.spent)} ⚡</span> : null}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * Лента моих запусков: какие были задачи и сколько за них списано. Строка
 * раскрывается по клику — как в админке по людям, только про себя: видно модуль,
 * объём работы, точную плату и когда шло. На «что я делал в среду» сумма за период
 * не отвечает — нужен список с датами, а на «сколько это стоило» — разбор задачи.
 */
function LogTab({ log }: { log: MyStats['log'] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!log.length) return <Card><EmptyState icon={<ListChecks size={26} />} title="Запусков за период нет" desc="Выберите другой период или запустите модуль." /></Card>

  const fmtDt = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const StatusTag = ({ s }: { s: string }) => (
    <span className={cn('rounded px-1 text-[10px] font-bold',
      s === 'done' ? 'bg-spark-500/12 text-spark-300'
        : s === 'paused' ? 'bg-amber-500/12 text-amber-300'
        : s === 'error' ? 'bg-red-500/12 text-red-300'
        : 'bg-white/8 text-muted')}>{s}</span>
  )

  return (
    <Card className="p-4">
      <div className="mb-2 text-xs text-muted">Нажмите на задачу — увидите, что она сделала и сколько за неё списано.</div>
      <div className="space-y-1">
        {log.map((t) => {
          const isOpen = open === t.id
          return (
            <div key={t.id} className="border-b border-line/30 last:border-0">
              <button
                onClick={() => setOpen(isOpen ? null : t.id)}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-left text-sm hover:bg-white/[.02]"
              >
                <ChevronDown size={13} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                <span className="font-medium text-fg">{t.title}</span>
                <StatusTag s={t.status} />
                {!!t.errors && <span className="rounded bg-red-500/12 px-1 text-[10px] font-bold text-red-300">{t.errors} ош.</span>}
                <span className="text-xs text-muted">{compact(t.actions)} действий</span>
                <span className={cn('ml-auto shrink-0 text-xs tabular-nums', t.spent ? 'text-amber-300' : 'text-faint')}>
                  {t.spent ? `${fmtCoins(t.spent)} ⚡` : '0 ⚡'}
                </span>
              </button>
              {isOpen && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line/30 bg-white/[.02] px-3 py-3 text-xs sm:grid-cols-4">
                  <Field label="Модуль" value={t.title} />
                  <Field label="Действий" value={compact(t.actions)} />
                  <Field label="Списано" value={t.spent ? `${fmtCoins(t.spent)} ⚡` : '—'} accent={t.spent ? 'text-amber-300' : undefined} />
                  <Field label="Ошибок" value={t.errors ? String(t.errors) : '—'} accent={t.errors ? 'text-red-300' : undefined} />
                  <Field label="Начато" value={fmtDt(t.at)} />
                  <Field label="Завершено" value={fmtDt(t.finishedAt)} />
                  <Field label="Статус" value={t.status} />
                  <Field label="ID задачи" value={t.id} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Field({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('truncate font-semibold tabular-nums', accent || 'text-fg')}>{value}</div>
    </div>
  )
}

/** Свой кошелёк: баланс и операции — за что списали и когда пополнили. */
function WalletTab({ coins }: { coins: number }) {
  const pushToast = useApp((s) => s.pushToast)
  const [rows, setRows] = useState<WalletEntry[] | null>(null)
  useEffect(() => {
    fetchWalletHistory(50)
      .then(setRows)
      .catch((e) => { setRows([]); pushToast({ type: 'error', title: 'Не удалось загрузить историю кошелька', desc: e instanceof Error ? e.message : '' }) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-1 flex items-center gap-2 text-xs text-muted"><Wallet size={14} /> На счету</div>
        <div className="font-display text-3xl font-bold text-fg">{fmtCoins(coins)} <span className="text-lg text-muted">⚡</span></div>
      </Card>

      {rows === null ? (
        <Card className="p-6 text-sm text-muted">Загрузка…</Card>
      ) : !rows.length ? (
        <Card><EmptyState icon={<Wallet size={26} />} title="Операций пока нет" desc="Здесь появятся пополнения и списания вашего кошелька." /></Card>
      ) : (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Операции по кошельку</div>
          <div className="space-y-1">
            {rows.map((r, i) => {
              const income = r.amount >= 0
              return (
                <div key={r.ts + '-' + i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/30 py-1.5 text-sm last:border-0">
                  <span className={cn('flex items-center gap-1 font-semibold tabular-nums', income ? 'text-spark-300' : 'text-amber-300')}>
                    {income ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                    {income ? '+' : ''}{fmtCoins(r.amount)} ⚡
                  </span>
                  {!!r.reason && <span className="min-w-0 flex-1 truncate text-muted">{r.reason}</span>}
                  <span className="text-xs tabular-nums text-faint">осталось {fmtCoins(r.after)} ⚡</span>
                  <span className="ml-auto shrink-0 tabular-nums text-faint">
                    {r.ts ? new Date(r.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}

function exportMyCsv(stats: MyStats, pushToast: (t: { type: 'success'; title: string; desc?: string }) => void) {
  const head = ['Модуль', 'Задач', 'Действий', 'Токенов', 'Монет']
  const rows = [
    head,
    ...stats.where.map((w) => [w.title, w.tasks, w.actions, w.tokens, w.spent]),
    ['ИТОГО', stats.totals.tasks, stats.totals.actions, stats.totals.tokens, stats.totals.spent],
  ]
  const csv = rows.map((r) => r.join(';')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'my-stats.csv'; a.click()
  URL.revokeObjectURL(url)
  pushToast({ type: 'success', title: 'CSV скачан', desc: 'my-stats.csv' })
}

/**
 * Демо-режим (без сессии): реального пользователя нет, поэтому показываем моки —
 * иначе витрина была бы пустой. Это прежнее содержимое «Моей статистики».
 */
function DemoStatistics() {
  const data = useApp((s) => s.data)
  const pushToast = useApp((s) => s.pushToast)
  const [range, setRange] = useState(1)
  const [tab, setTab] = useState('dashboard')
  const loading = useMockLoading(600, [range, tab])

  const mul = [0.16, 1, 3.4, 9.2][range]
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
        title="Статистика"
        subtitle="Активность аккаунтов и модулей"
        icon={<BarChart3 size={22} />}
        actions={<>
          <HelpButton topic="my-statistics" className="h-10 w-10" />
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
                    <span className="text-xs font-semibold text-spark-300">+{(8 + (range + 1) * 3)}%</span>
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
                {activeAccounts(data).map((acc, i) => (
                  <tr key={acc.id} className="border-b border-line/50 last:border-0 hover:bg-elevated/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={acc.name} color={acc.avatarColor} size={32} />
                        <div><div className="font-semibold text-fg">{acc.name}</div><div className="text-xs text-muted">@{acc.username}</div></div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={acc.status} /></td>
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
