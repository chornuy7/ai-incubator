import { coins as fmtCoins, cn } from '@/shared/lib/utils'
import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Users, ListChecks, Coins, Download, RefreshCw, AlertTriangle, Contact, Power, ChevronDown, Activity, Plus } from 'lucide-react'
import { PageHeader, Card, Segmented, EmptyState } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import {
  fetchAdminOverview, fetchClientReport, fetchUsersReport, fetchProblems, fetchCrmOverview,
  fetchActiveNow, fetchDailySpend,
  type AdminOverview, type ClientReport, type UsersReport, type Problems, type CrmOverview,
  type ActiveNow, type ActiveTask, type DailySpend,
} from '@/api/adminApi'
import { updateUser } from '@/api/usersApi'
import { changeBalance } from '@/api/balanceApi'
import { promptDialog } from '@/shared/lib/dialog'

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
  const [users, setUsers] = useState<UsersReport | null>(null)
  const [problems, setProblems] = useState<Problems | null>(null)
  const [crm, setCrm] = useState<CrmOverview | null>(null)
  const [active, setActive] = useState<ActiveNow | null>(null)
  const [daily, setDaily] = useState<DailySpend | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)

  const since = useMemo(() => Date.now() - PERIODS[periodIdx].days * 24 * 60 * 60 * 1000, [periodIdx])

  const load = async () => {
    setLoading(true)
    try {
      // Грузим всё одним заходом: цифры на разных вкладках должны быть на один момент
      // времени, иначе «в панели 82 задачи, а по людям 80» читается как ошибка счёта.
      const [o, r, u, p, c, a, d] = await Promise.all([
        fetchAdminOverview(since), fetchClientReport(since),
        fetchUsersReport(since), fetchProblems(since), fetchCrmOverview(),
        fetchActiveNow(), fetchDailySpend(PERIODS[periodIdx].days),
      ])
      setOverview(o); setReport(r); setUsers(u); setProblems(p); setCrm(c)
      setActive(a); setDaily(d); setDenied(false)
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
    // Монеты разбиты на две статьи: клиент вправе видеть, за что именно списано —
    // за сами действия по прайсу и отдельно за работу ИИ.
    const head = ['Модуль', 'Задач', 'Завершено', 'Действий', 'Токенов', 'Монет за действия', 'Монет за ИИ', 'Монет всего']
    const lines = [
      `Отчёт за период ${fmtDate(report.since)} — ${fmtDate(report.until)}`,
      head.join(';'),
      ...report.rows.map((r) => [r.title, r.tasks, r.completed, r.actions, r.tokens, r.actionCoins ?? 0, r.tokenCoins ?? 0, r.coins].join(';')),
      ['ИТОГО', report.totals.tasks, '', report.totals.actions, report.totals.tokens,
       report.totals.actionCoins ?? 0, report.totals.tokenCoins ?? 0, report.totals.coins].join(';'),
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
        <Segmented options={['Панель', 'Сейчас', 'По дням', 'Пользователи', 'Проблемы', 'CRM', 'Отчёт клиенту']} value={tab} onChange={setTab} />
        <Segmented options={PERIODS.map((p) => p.label)} value={periodIdx} onChange={setPeriodIdx} size="sm" />
      </div>

      {loading && !overview ? (
        <Card className="p-6 text-sm text-muted">Загрузка…</Card>
      ) : tab === 0 ? (
        <PanelTab o={overview} />
      ) : tab === 1 ? (
        <ActiveTab active={active} onReload={load} />
      ) : tab === 2 ? (
        <DailyTab daily={daily} />
      ) : tab === 3 ? (
        <UsersTab report={users} onReload={load} />
      ) : tab === 4 ? (
        <ProblemsTab p={problems} />
      ) : tab === 5 ? (
        <CrmTab crm={crm} />
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
          icon={<Coins size={14} />} label="Монет в системе"
          value={o.coinTotal ? fmtCoins(o.coinTotal.coins) : (o.balance ? fmtCoins(o.balance.coins) : '—')}
          hint={o.coinTotal ? `на ${o.coinTotal.wallets} кошельках пользователей` : undefined}
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
                <td
                  className="py-2 text-right tabular-nums text-amber-300"
                  title={`За действия ${fmtCoins(r.actionCoins ?? 0)} + за ИИ ${fmtCoins(r.tokenCoins ?? 0)}`}
                >{r.coins ? fmtCoins(r.coins) : '—'}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-2 pr-3 text-fg">ИТОГО</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tasks)}</td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.actions)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tokens)}</td>
              <td
                className="py-2 text-right tabular-nums text-amber-300"
                title={`За действия ${fmtCoins(report.totals.actionCoins ?? 0)} + за ИИ ${fmtCoins(report.totals.tokenCoins ?? 0)}`}
              >{report.totals.coins ? fmtCoins(report.totals.coins) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * §5.3 «трекинг пользователей»: кто, что делал, сколько потратил и КУДА.
 *
 * Отключить человека можно прямо отсюда: админ смотрит статистику и тут же видит,
 * кого пора закрыть, — уходить за этим на другую страницу значит терять контекст.
 * Строка раскрывается в разрез по модулям: «потратил 5 000 токенов» без «на что»
 * не отвечает ни на один реальный вопрос.
 */
function UsersTab({ report, onReload }: { report: UsersReport | null; onReload: () => void }) {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (!report) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!report.rows.length) return <EmptyState icon={<Users size={22} />} title="Пользователей нет" />

  /**
   * Пополнение прямо из таблицы: админ видит, у кого кончаются монеты, и тут же
   * доливает — иначе за этим надо уходить в чужой профиль и терять, кому доливал.
   * Отрицательная сумма списывает: та же операция, тот же аудит.
   */
  const topUp = async (userId: string, email: string) => {
    const raw = await promptDialog({
      title: 'Пополнить кошелёк',
      message: `Сколько монет начислить: ${email}? Отрицательное число — списать.`,
      placeholder: '10',
    })
    if (raw === null) return
    const amount = Number(String(raw).replace(',', '.'))
    if (!Number.isFinite(amount) || !amount) {
      pushToast({ type: 'error', title: 'Нужно число', desc: 'Например 10 или -2.5' })
      return
    }
    setBusy(userId)
    try {
      await changeBalance({ amount, reason: 'Начисление из админ-панели', userId })
      pushToast({ type: 'success', title: amount > 0 ? `Начислено ${amount} ⚡` : `Списано ${-amount} ⚡`, desc: email })
      onReload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось изменить баланс', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(null) }
  }

  const toggle = async (userId: string, active: boolean) => {
    setBusy(userId)
    try {
      await updateUser(userId, { active: !active })
      pushToast({ type: 'success', title: !active ? 'Пользователь включён' : 'Пользователь отключён' })
      onReload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось изменить', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(null) }
  }

  return (
    <Card className="p-4">
      <p className="mb-3 text-xs text-muted">
        Строка — человек. Нажмите на неё, чтобы увидеть, в каких модулях он работал.
        «Списано» — плата за действия по его задачам, «На счету» — что осталось в кошельке.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="pb-2 pr-3 font-medium">Пользователь</th>
              <th className="pb-2 pr-3 text-right font-medium">Задач</th>
              <th className="pb-2 pr-3 text-right font-medium">Действий</th>
              <th className="pb-2 pr-3 text-right font-medium">Токенов</th>
              <th className="pb-2 pr-3 text-right font-medium">Списано</th>
              <th className="pb-2 pr-3 text-right font-medium">На счету</th>
              <th className="pb-2 text-right font-medium">Доступ</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => {
              // Строки без реального пользователя (удалённые, задачи без владельца)
              // отключать нечего — кнопки у них нет, но из счёта они не исчезают.
              const real = !!r.userId && !r.email.startsWith('без владельца') && !r.email.startsWith('удалённый')
              const isOpen = open === r.userId
              return [
                <tr
                  key={r.userId}
                  className="cursor-pointer border-b border-line/50 hover:bg-white/[.02]"
                  onClick={() => setOpen(isOpen ? null : r.userId)}
                >
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5">
                      <ChevronDown size={13} className={cn('text-muted transition-transform', isOpen && 'rotate-180')} />
                      <span className={cn('text-fg', !r.active && real && 'text-muted line-through')}>{r.email || r.userId}</span>
                      {!r.active && real && <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">отключён</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tasks)}</td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums text-fg">{fmt(r.actions)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tokens)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-amber-300">{r.spent ? fmtCoins(r.spent) : '—'}</td>
                  <td className="py-2 pr-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="tabular-nums text-fg">{r.coins ? fmtCoins(r.coins) : '—'}</span>
                      {real && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void topUp(r.userId, r.email) }}
                          disabled={busy === r.userId}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line text-muted transition-colors hover:border-spark-500/40 hover:text-spark-300 disabled:opacity-40"
                          title="Пополнить кошелёк"
                        >
                          <Plus size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-right">
                    {real ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void toggle(r.userId, r.active) }}
                        disabled={busy === r.userId}
                        className={cn('inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-semibold disabled:opacity-40',
                          r.active ? 'border-line text-muted hover:border-red-500/40 hover:text-red-300' : 'border-spark-500/40 text-spark-300')}
                        title={r.active ? 'Отключить доступ' : 'Включить доступ'}
                      >
                        <Power size={12} /> {r.active ? 'Отключить' : 'Включить'}
                      </button>
                    ) : <span className="text-xs text-muted">—</span>}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={r.userId + '-where'} className="border-b border-line/50 bg-white/[.02]">
                    <td colSpan={7} className="px-3 py-2">
                      {r.where.length ? (
                        <div className="grid gap-1 sm:grid-cols-2">
                          {r.where.map((w) => (
                            <div key={w.moduleKey} className="flex items-baseline justify-between gap-3 text-xs">
                              <span className="text-muted">{w.title}</span>
                              <span className="tabular-nums text-fg">
                                {fmt(w.actions)} действий
                                {w.tokens ? <span className="text-muted"> · {fmt(w.tokens)} ток.</span> : null}
                                {w.spent ? <span className="text-amber-300"> · {fmtCoins(w.spent)} ⚡</span> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : <span className="text-xs text-muted">Ничего не запускал.</span>}
                    </td>
                  </tr>
                ) : null,
              ]
            })}
            <tr className="font-semibold">
              <td className="py-2 pr-3 text-fg">ИТОГО</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tasks)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.actions)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tokens)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-300">{fmtCoins(report.totals.spent)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmtCoins(report.totals.coins)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * §5.3: где сейчас болит. Три беды разведены намеренно — у них разные действия:
 * ошибки чинит настройка, бан/flood — замена аккаунта, пауза из-за денег — пополнение.
 */
function ProblemsTab({ p }: { p: Problems | null }) {
  if (!p) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const quiet = !p.failedTotal && !p.pausedNoCoins.length && !p.accounts.banned && !p.accounts.flood && !p.accounts.noProxy
  if (quiet) return <EmptyState icon={<AlertTriangle size={22} />} title="Всё спокойно" desc="Ошибок, банов и остановок из-за баланса нет." />

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Задач с ошибками</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.failedTotal)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Встали из-за баланса</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmt(p.pausedNoCoins.length)}</div>
          <div className="mt-0.5 text-[11px] text-muted">чинится пополнением</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Аккаунты</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.accounts.banned + p.accounts.flood)}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            бан {p.accounts.banned} · flood {p.accounts.flood} · без прокси {p.accounts.noProxy}
          </div>
        </Card>
      </div>

      {!!p.failedTasks.length && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Где именно ошибки</div>
          <div className="space-y-1.5">
            {p.failedTasks.map((t) => (
              <div key={t.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/40 pb-1.5 text-sm last:border-0">
                <span className="font-medium text-fg">{t.title}</span>
                <span className="rounded-md bg-red-500/12 px-1.5 py-0.5 text-[11px] font-bold text-red-300">{t.errors} ош.</span>
                <span className="text-xs text-muted">{t.id}</span>
                <span className="w-full text-xs text-muted sm:w-auto sm:flex-1 sm:truncate">{t.lastError}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!!p.pausedNoCoins.length && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Ждут пополнения</div>
          <div className="text-sm text-muted">
            {p.pausedNoCoins.map((t) => t.title + ' (' + t.id + ')').join(' · ')}
          </div>
        </Card>
      )}
    </div>
  )
}

/**
 * CRM в админке: воронка и — главное — ЗАВИСШИЕ лиды.
 *
 * Их не видно ни в одном счётчике статусов: лид формально «в работе», а по факту
 * им никто не занимался несколько дней. Это и есть потерянные деньги, поэтому
 * вынесено отдельной цифрой, а не спрятано в разбивке.
 */
function CrmTab({ crm }: { crm: CrmOverview | null }) {
  if (!crm) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!crm.total) return <EmptyState icon={<Contact size={22} />} title="Лидов пока нет" desc="Появятся, когда модули начнут доводить людей до диалога." />

  const LABELS: Record<string, string> = {
    cold: 'Холодные', contacted: 'Написали', warm: 'Тёплые', interested: 'Заинтересованы',
    hot: 'Горячие', target: 'Целевое действие', closed: 'Закрыты',
  }
  const max = Math.max(...Object.values(crm.byStatus), 1)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-muted">Всего лидов</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(crm.total)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Горячие</div>
          <div className="font-display text-2xl font-bold text-spark-300">{fmt(crm.hot)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Зависшие</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmt(crm.stuck)}</div>
          <div className="mt-0.5 text-[11px] text-muted">в работе, но молчат больше {crm.stuckDays} дн.</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Конверсия в цель</div>
          <div className="font-display text-2xl font-bold text-fg">{crm.conversion}%</div>
          <div className="mt-0.5 text-[11px] text-muted">{fmt(crm.target)} довели до целевого</div>
        </Card>
      </div>

      {!!crm.owners.length && (
        <Card className="p-4">
          <div className="mb-2.5 text-sm font-semibold text-fg">Кто ведёт лидов</div>
          <div className="space-y-1.5">
            {crm.owners.map((o) => (
              <div key={o.accountId} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg">{o.name}</span>
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-spark-500/70" style={{ width: (o.count / Math.max(...crm.owners.map((x) => x.count), 1)) * 100 + '%' }} />
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums text-fg">{fmt(o.count)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 text-sm font-semibold text-fg">Воронка по статусам</div>
        <div className="space-y-1.5">
          {Object.entries(crm.byStatus).map(([k, v]) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-sm text-muted">{LABELS[k] || k}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-spark-500/70" style={{ width: (v / max) * 100 + '%' }} />
              </div>
              <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{fmt(v)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

/**
 * «Сейчас» — что идёт в эту минуту.
 *
 * Сводка за период отвечает «что было», но владельцу чаще нужно «что идёт»: успеет
 * ли до ночи, не встало ли, кто запустил. Вставшие из-за денег вынесены отдельно —
 * это единственная поломка, которую чинит не разбирательство, а пополнение.
 */
function ActiveTab({ active, onReload }: { active: ActiveNow | null; onReload: () => void }) {
  if (!active) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const nothing = !active.running.length && !active.paused.length
  if (nothing) return <EmptyState icon={<Activity size={22} />} title="Сейчас ничего не идёт" desc="Ни одной запущенной или приостановленной задачи." />

  const Row = ({ t }: { t: ActiveTask }) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/40 py-2 text-sm last:border-0">
      <span className="font-medium text-fg">{t.title}</span>
      <span className="text-xs text-muted">{t.id}</span>
      {t.pausedByCoins && (
        <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">ждёт пополнения</span>
      )}
      <span className="text-xs text-muted">{t.accounts} акк.</span>
      <div className="flex min-w-[120px] flex-1 items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <div className={cn('h-full rounded-full', t.status === 'running' ? 'bg-spark-500' : 'bg-amber-400/70')} style={{ width: t.percent + '%' }} />
        </div>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">
          {fmt(t.done)}{t.total ? '/' + fmt(t.total) : ''}
        </span>
      </div>
      {!!t.spentCoins && <span className="text-xs tabular-nums text-amber-300">{fmtCoins(t.spentCoins)} ⚡</span>}
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onReload} className="btn-ghost h-8 text-xs"><RefreshCw size={13} /> Обновить</button>
        <span className="text-xs text-muted">Данные на момент загрузки страницы.</span>
      </div>

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
          <Activity size={15} className="text-spark-400" /> Идёт сейчас
          <span className="text-muted">{active.running.length}</span>
        </div>
        {active.running.length
          ? active.running.map((t) => <Row key={t.id} t={t} />)
          : <div className="py-2 text-sm text-muted">Ничего не запущено.</div>}
      </Card>

      {!!active.paused.length && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            Приостановлены <span className="text-muted">{active.paused.length}</span>
          </div>
          {active.paused.map((t) => <Row key={t.id} t={t} />)}
        </Card>
      )}
    </div>
  )
}

/**
 * Расход по дням. Столбцы намеренно двухцветные: плата за действия и за ИИ ведут
 * себя по-разному, и «вчера потратили втрое больше» без ответа «на что» бесполезно.
 *
 * Точность источников разная, и подпись говорит это прямо: журнал ИИ пишет каждое
 * обращение с меткой времени, а плата за действия хранится итогом на задаче и
 * ложится на день её создания.
 */
function DailyTab({ daily }: { daily: DailySpend | null }) {
  if (!daily) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const rows = daily.rows
  const max = Math.max(...rows.map((r) => r.coins), 0.001)
  const maxActions = Math.max(...rows.map((r) => r.actions), 1)
  const totalCoins = rows.reduce((n, r) => n + r.coins, 0)
  const busiest = rows.reduce((a, b) => (b.actions > a.actions ? b : a), rows[0])

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Потрачено за {daily.days} дн.</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmtCoins(totalCoins)} ⚡</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">В среднем в день</div>
          <div className="font-display text-2xl font-bold text-fg">{fmtCoins(totalCoins / Math.max(1, daily.days))} ⚡</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Самый нагруженный день</div>
          <div className="font-display text-2xl font-bold text-fg">{busiest ? fmt(busiest.actions) : 0}</div>
          <div className="mt-0.5 text-[11px] text-muted">{busiest ? busiest.day : '—'} · действий</div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-1 text-sm font-semibold text-fg">Монеты по дням</div>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-amber-400" /> за действия</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-spark-500" /> за ИИ</span>
        </div>
        <div className="flex h-40 items-end gap-1 overflow-x-auto">
          {rows.map((r) => {
            const h = (r.coins / max) * 100
            const aiPart = r.coins ? (r.tokenCoins / r.coins) * 100 : 0
            return (
              <div key={r.day} className="flex min-w-[14px] flex-1 flex-col items-center gap-1" title={`${r.day}: ${fmtCoins(r.coins)} ⚡ (действия ${fmtCoins(r.actionCoins)} + ИИ ${fmtCoins(r.tokenCoins)}) · ${fmt(r.actions)} действий`}>
                <div className="flex w-full flex-1 items-end">
                  <div className="w-full overflow-hidden rounded-t bg-line/40" style={{ height: Math.max(2, h) + '%' }}>
                    <div className="h-full w-full bg-amber-400/80">
                      <div className="w-full bg-spark-500" style={{ height: aiPart + '%' }} />
                    </div>
                  </div>
                </div>
                <span className="shrink-0 text-[9px] tabular-nums text-faint">{r.day.slice(8)}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Расход ИИ берётся из журнала обращений — с точной меткой времени. Плата за действия
          хранится итогом на задаче, поэтому ложится на день её создания.
        </p>
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-fg">Действия по дням</div>
        <div className="space-y-1">
          {rows.filter((r) => r.actions || r.tasks).map((r) => (
            <div key={r.day} className="flex items-center gap-3 text-xs">
              <span className="w-20 shrink-0 tabular-nums text-muted">{r.day}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-spark-500/60" style={{ width: (r.actions / maxActions) * 100 + '%' }} />
              </div>
              <span className="w-24 shrink-0 text-right tabular-nums text-fg">{fmt(r.actions)} действий</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted">{fmt(r.tasks)} задач</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
