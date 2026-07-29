import { AlertTriangle } from 'lucide-react'
import { Card, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import type { AccountsHealth, ActiveNow, DailySpend } from '@/api/adminApi'
import { fmt, MetricTile } from './adminShared'

export const STATUS_LABEL_RU: Record<string, string> = {
  active: 'Активны', warming: 'Прогрев', pause: 'На паузе', floodwait: 'FloodWait',
  quarantine: 'Карантин', spamblock: 'Спам-блок', reauth: 'Нужен вход', invalid: 'Невалидны',
}

/**
 * §10.9: мониторинг здоровья аккаунтов — работают / на паузе / падают, с причиной
 * по каждому проблемному. Всегда виден (в отличие от «Проблем», которые прячутся,
 * когда тихо): владелец должен видеть парк аккаунтов и почему кто-то выпал.
 */
export function MonitoringTab({ health, active, daily }: { health: AccountsHealth | null; active: ActiveNow | null; daily: DailySpend | null }) {
  if (!health) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!health.total) return <EmptyState icon={<AlertTriangle size={22} />} title="Аккаунтов нет" desc="Добавьте аккаунты в менеджере профилей." />

  // §10.9: нагрузка системы «сейчас» — сколько задач крутится, сколько аккаунтов
  // занято, сегодняшний поток действий, сколько встало из-за баланса.
  const running = active?.running ?? []
  const paused = active?.paused ?? []
  const accountsInWork = running.reduce((s, t) => s + (t.accounts || 0), 0)
  const pausedByCoins = paused.filter((t) => t.pausedByCoins).length
  const lastDay = daily?.rows?.[(daily.rows.length || 0) - 1]
  const todayActions = lastDay?.actions ?? 0

  const statusTone: Record<string, string> = {
    floodwait: 'text-amber-300', quarantine: 'text-amber-300',
    spamblock: 'text-red-300', invalid: 'text-red-300', reauth: 'text-iris-300',
  }
  const untilText = (until: number) => {
    if (!until) return ''
    const left = until - Date.now()
    if (left <= 0) return 'срок истёк'
    const min = Math.round(left / 60000)
    return min >= 60 ? `ещё ~${Math.round(min / 60)} ч` : `ещё ~${min} мин`
  }

  return (
    <div className="space-y-3">
      {/* §10.9: нагрузка «сейчас» — задачи в работе, занятые аккаунты, поток действий. */}
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Задач в работе" value={fmt(running.length)} tone="text-spark-300" sub={`на паузе ${fmt(paused.length)}${pausedByCoins ? ` · из-за баланса ${fmt(pausedByCoins)}` : ''}`} />
        <MetricTile label="Аккаунтов занято" value={fmt(accountsInWork)} sub="в активных задачах" />
        <MetricTile label="Действий сегодня" value={fmt(todayActions)} sub="поток за день" />
        <MetricTile label="Аккаунтов всего" value={fmt(health.total)} sub={`работают ${fmt(health.healthy)} · падают ${fmt(health.problem)}`} />
      </div>

      <div className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Здоровье аккаунтов</div>
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Всего аккаунтов" value={fmt(health.total)} />
        <MetricTile label="Работают" value={fmt(health.healthy)} tone="text-spark-300" sub="активны + прогрев" />
        <MetricTile label="На паузе" value={fmt(health.idle)} sub="остановлены командой" />
        <MetricTile label="Падают" value={fmt(health.problem)} tone={health.problem ? 'text-red-300' : undefined} sub="flood / бан / невалид" />
      </div>

      {/* Раскладка по статусам + усталость. */}
      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-fg">По статусам</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(health.byStatus).sort((a, b) => b[1] - a[1]).map(([st, n]) => (
            <span key={st} className={cn('rounded-lg border border-line px-2 py-1 text-xs', statusTone[st] || 'text-muted')}>
              {STATUS_LABEL_RU[st] || st}: <b className="text-fg">{n}</b>
            </span>
          ))}
          {!!health.resting && <span className="rounded-lg border border-line px-2 py-1 text-xs text-muted">отдыхают: <b className="text-fg">{health.resting}</b></span>}
          {!!health.tired && <span className="rounded-lg border border-line px-2 py-1 text-xs text-amber-300">устали (≥70%): <b className="text-fg">{health.tired}</b></span>}
        </div>
      </Card>

      {/* Проблемные — по каждому причина и до какого времени. */}
      {health.problems.length ? (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Падающие аккаунты — почему ({health.problems.length})</div>
          <div className="space-y-1.5">
            {health.problems.map((a) => (
              <div key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/40 pb-1.5 text-sm last:border-0">
                <span className="font-medium text-fg">{a.name}</span>
                {!!a.phone && <span className="text-xs text-muted">{a.phone}</span>}
                <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-bold', statusTone[a.status] || 'text-muted', 'bg-white/8')}>{a.statusLabel}</span>
                {!!a.reason && <span className="w-full text-xs text-muted sm:w-auto sm:flex-1 sm:truncate">{a.reason}</span>}
                {!!a.until && <span className="shrink-0 text-[11px] text-faint">{untilText(a.until)}</span>}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-4 text-sm text-muted">Падающих аккаунтов нет — весь парк в работе или на паузе.</Card>
      )}
    </div>
  )
}
