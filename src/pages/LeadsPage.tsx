import { useEffect, useMemo, useState } from 'react'
import { Users, Plus, Trash2, Flame, MessageSquare } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import { fetchLeads, createLead, updateLead, deleteLead, sortLeadsByPriority, LEAD_STATUSES, type Lead, type LeadStatus } from '@/api/leadsApi'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { LeadConversationModal } from '@/features/leads/LeadConversationModal'

// §9: воронка прогрева. Порядок = движение к цели; «Горячий» — мгновенный алерт.
const STATUS: Record<LeadStatus, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  cold: { label: 'Холодный', tone: 'muted' },
  contacted: { label: 'Только написал', tone: 'iris' },
  warm: { label: 'Прогретый', tone: 'amber' },
  interested: { label: 'Заинтересованный', tone: 'spark' },
  hot: { label: 'Горячий', tone: 'rose' },
  target: { label: 'Целевое', tone: 'spark' },
  closed: { label: 'Закрыт', tone: 'muted' },
}

export function LeadsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [leads, setLeads] = useState<Lead[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [fGoal, setFGoal] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [peer, setPeer] = useState('')
  const [newGoal, setNewGoal] = useState('')
  /** Лид, чью переписку открыли. */
  const [chatLead, setChatLead] = useState<Lead | null>(null)

  const goalName = useMemo(() => {
    const m = new Map(goals.map((g) => [g.id, g.name]))
    return (id?: string | null) => (id ? m.get(id) || '—' : '')
  }, [goals])

  const load = async () => {
    try {
      const [l, g] = await Promise.all([
        fetchLeads({ goalId: fGoal || undefined, status: (fStatus as LeadStatus) || undefined }),
        fetchGoals().catch(() => []),
      ])
      setLeads(l); setGoals(g)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить лидов', desc: err instanceof Error ? err.message : '' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [fGoal, fStatus])

  const counts = useMemo(() => {
    const c = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>
    for (const l of leads) c[l.status] += 1
    return c
  }, [leads])

  const add = async () => {
    if (!peer.trim()) return pushToast({ type: 'error', title: 'Укажите контакт лида' })
    try {
      await createLead({ peer: peer.trim(), goalId: newGoal || null })
      setPeer('')
      pushToast({ type: 'success', title: 'Лид добавлен' })
      await load()
    } catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }

  const setStatus = async (l: Lead, status: LeadStatus) => {
    try {
      await updateLead(l.id, { status })
      // §9: горячий лид — мгновенный алерт менеджеру.
      if (status === 'hot' && l.status !== 'hot') {
        pushToast({ type: 'error', title: '🔥 Горячий лид!', desc: `${l.peer}${l.goalId ? ` · цель: ${goalName(l.goalId)}` : ''} — свяжитесь немедленно` })
      }
      await load()
    }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }
  const remove = async (l: Lead) => {
    if (!(await confirmDialog({ title: 'Удалить лида?', message: `${l.peer} будет удалён из CRM.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteLead(l.id); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }

  const goalOptions = [{ value: '', label: 'Все цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]
  const statusOptions = [{ value: '', label: 'Все статусы' }, ...LEAD_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))]

  return (
    <div>
      <PageHeader
        title="CRM · Лиды"
        subtitle="Лиды кампаний: воронка по статусам, ответственный аккаунт, движение к цели."
        icon={<Users size={22} />}
        actions={<HelpButton topic="crm" className="h-10 w-10" />}
      />

      {/* §9: горячие лиды — заметный алерт-баннер, требуют немедленного внимания. */}
      {counts.hot > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-200">
          <Flame size={18} className="animate-pulse text-rose-400" />
          {counts.hot} {counts.hot === 1 ? 'горячий лид' : 'горячих лидов'} — свяжитесь немедленно
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {LEAD_STATUSES.map((s) => (
          <div key={s} className={`rounded-lg p-3 ${s === 'hot' && counts.hot > 0 ? 'bg-rose-500/10 ring-1 ring-rose-500/30' : 'bg-white/5'}`}>
            <div className="text-xs text-white/50">{STATUS[s].label}</div>
            <div className="text-xl font-semibold text-white">{counts[s]}{s === 'hot' && counts.hot > 0 && <Flame size={14} className="mb-1 ml-1 inline text-rose-400" />}</div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={fGoal} onChange={setFGoal} options={goalOptions} className="w-48" />
        <Select value={fStatus} onChange={setFStatus} options={statusOptions} className="w-40" />
        <div className="ml-auto flex items-center gap-2">
          <input className="input h-9 w-44" value={peer} onChange={(e) => setPeer(e.target.value)} placeholder="@username лида" onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <Select value={newGoal} onChange={setNewGoal} options={goalOptions} className="w-40" placeholder="Цель" />
          <button onClick={() => void add()} className="btn-primary h-9"><Plus size={15} /> Лид</button>
        </div>
      </div>

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : leads.length === 0 ? (
        <EmptyState icon={<Users size={26} />} title="Лидов пока нет" desc="Добавьте лид вручную или он появится из диалогов кампании." />
      ) : (
        <div className="flex flex-col gap-2">
          {/* §3.6: приоритет ответившему — горячие/ответившие лиды выше */}
          {sortLeadsByPriority(leads).map((l) => (
            <Card key={l.id} className="flex flex-wrap items-center gap-2 p-3">
              <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
              <button
                onClick={() => setChatLead(l)}
                className="font-semibold text-white hover:text-spark-300"
                title="Открыть переписку с этим человеком"
              >
                {l.peer}
              </button>
              {l.goalId && <span className="text-xs text-iris-300">цель: {goalName(l.goalId)}</span>}
              {l.accountId && <span className="text-xs text-white/40">акк: {l.accountId.slice(-6)}</span>}
              <div className="ml-auto flex items-center gap-2">
                <Select
                  value={l.status}
                  onChange={(v) => void setStatus(l, v as LeadStatus)}
                  options={LEAD_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))}
                  className="w-44"
                />
                <button onClick={() => setChatLead(l)} className="btn-icon h-8 w-8" aria-label="Открыть переписку" title="Открыть переписку"><MessageSquare size={14} /></button>
                <button onClick={() => void remove(l)} className="btn-icon-danger h-8 w-8" aria-label="Удалить лида" title="Удалить лида"><Trash2 size={14} /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <LeadConversationModal source={chatLead ? { kind: 'lead', lead: chatLead } : null} onClose={() => setChatLead(null)} />
    </div>
  )
}
