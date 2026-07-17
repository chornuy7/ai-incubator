import { useEffect, useMemo, useState } from 'react'
import { TrendingUp, Flame, Target, Send, MessageSquare } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { fetchLeads, LEAD_STATUSES, type Lead, type LeadStatus } from '@/api/leadsApi'
import { fetchAllTasks, type ModuleTask } from '@/api/modulesApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'

const STATUS_LABEL: Record<LeadStatus, string> = {
  cold: 'Холодные', answered: 'Ответили', hot: 'Горячие', target: 'Целевое', closed: 'Закрыты',
}

function actionsOf(t: ModuleTask) {
  return t.progress?.actionsDone ?? t.progress?.commentsSent ?? t.progress?.done ?? 0
}

function Metric({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string | number; accent?: string }) {
  return (
    <div className="rounded-xl bg-white/5 p-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-white/50">{icon}{label}</div>
      <div className={`text-2xl font-semibold ${accent || 'text-white'}`}>{value}</div>
    </div>
  )
}

export function AnalyticsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [leads, setLeads] = useState<Lead[]>([])
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const [l, t, g] = await Promise.all([fetchLeads(), fetchAllTasks(), fetchGoals().catch(() => [])])
        setLeads(l); setTasks(t); setGoals(g)
      } catch (err) {
        pushToast({ type: 'error', title: 'Не удалось загрузить аналитику', desc: err instanceof Error ? err.message : '' })
      } finally { setLoading(false) }
    })()
  }, [])

  const m = useMemo(() => {
    const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>
    for (const l of leads) byStatus[l.status] += 1
    const total = leads.length
    const active = byStatus.answered + byStatus.hot
    const sent = tasks.reduce((a, t) => a + actionsOf(t), 0)
    const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length
    const conversion = total ? Math.round((byStatus.target / total) * 100) : 0
    const replyRate = sent ? Math.round(((byStatus.answered + byStatus.hot + byStatus.target) / sent) * 100) : 0
    return { byStatus, total, active, sent, runningTasks, conversion, replyRate }
  }, [leads, tasks])

  const perGoal = useMemo(() => {
    return goals.map((g) => {
      const gl = leads.filter((l) => l.goalId === g.id)
      const target = gl.filter((l) => l.status === 'target').length
      const hot = gl.filter((l) => l.status === 'hot').length
      const gt = tasks.filter((t) => t.goalId === g.id)
      return { goal: g, leads: gl.length, hot, target, tasks: gt.length, conv: gl.length ? Math.round((target / gl.length) * 100) : 0 }
    }).filter((r) => r.leads || r.tasks)
  }, [goals, leads, tasks])

  return (
    <div>
      <PageHeader title="Аналитика" subtitle="Воронка кампаний: отправлено, ответы, активные диалоги, горячие лиды, конверсия." icon={<TrendingUp size={22} />} actions={<HelpButton topic="analytics" className="h-10 w-10" />} />

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric icon={<Send size={13} />} label="Отправлено" value={m.sent} />
            <Metric icon={<MessageSquare size={13} />} label="Ответы (аппрокс.)" value={`${m.replyRate}%`} />
            <Metric icon={<MessageSquare size={13} />} label="Активные диалоги" value={m.active} accent="text-iris-300" />
            <Metric icon={<Flame size={13} />} label="Горячие лиды" value={m.byStatus.hot} accent="text-rose-300" />
            <Metric icon={<Target size={13} />} label="Целевые действия" value={m.byStatus.target} accent="text-spark-300" />
            <Metric icon={<TrendingUp size={13} />} label="Конверсия" value={`${m.conversion}%`} accent="text-spark-300" />
          </div>

          <Card className="mb-4 p-4">
            <div className="mb-2 text-sm text-white/60">Воронка лидов ({m.total})</div>
            <div className="flex flex-col gap-1.5">
              {LEAD_STATUSES.map((s) => {
                const v = m.byStatus[s]
                const w = m.total ? Math.round((v / m.total) * 100) : 0
                return (
                  <div key={s} className="flex items-center gap-2">
                    <div className="w-24 shrink-0 text-xs text-white/50">{STATUS_LABEL[s]}</div>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-white/10">
                      <div className="h-full rounded bg-spark-500/70" style={{ width: `${w}%` }} />
                    </div>
                    <div className="w-10 shrink-0 text-right text-xs text-white/70">{v}</div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card className="p-0">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white/60">По целям</div>
            {perGoal.length === 0 ? (
              <div className="px-4 py-6 text-sm text-white/40">Нет данных по целям. Создайте цель, запустите модуль и добавьте лидов.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-white/40">
                    <tr className="border-b border-white/5">
                      <th className="px-4 py-2 text-left font-normal">Цель</th>
                      <th className="px-3 py-2 text-right font-normal">Задачи</th>
                      <th className="px-3 py-2 text-right font-normal">Лиды</th>
                      <th className="px-3 py-2 text-right font-normal">Горячие</th>
                      <th className="px-3 py-2 text-right font-normal">Целевые</th>
                      <th className="px-4 py-2 text-right font-normal">Конверсия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perGoal.map((r) => (
                      <tr key={r.goal.id} className="border-b border-white/5">
                        <td className="px-4 py-2 text-white">{r.goal.name}</td>
                        <td className="px-3 py-2 text-right text-white/70">{r.tasks}</td>
                        <td className="px-3 py-2 text-right text-white/70">{r.leads}</td>
                        <td className="px-3 py-2 text-right text-rose-300">{r.hot}</td>
                        <td className="px-3 py-2 text-right text-spark-300">{r.target}</td>
                        <td className="px-4 py-2 text-right text-white">{r.conv}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
