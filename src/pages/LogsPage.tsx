import { useEffect, useMemo, useState } from 'react'
import { ScrollText, RefreshCw } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Badge } from '@/shared/ui'
import { fetchAudit, type AuditEntry } from '@/api/auditApi'

// Человеческие подписи и тон по префиксу действия.
function actionMeta(action: string): { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' } {
  if (action.startsWith('account.status')) return { label: 'Статус аккаунта', tone: 'amber' }
  if (action.startsWith('account.transfer')) return { label: 'Перенос профиля', tone: 'iris' }
  if (action.startsWith('campaign')) return { label: 'Кампания', tone: 'spark' }
  if (action.startsWith('task.start')) return { label: 'Старт задачи', tone: 'spark' }
  if (action.startsWith('task.stop')) return { label: 'Стоп задачи', tone: 'muted' }
  if (action.startsWith('task')) return { label: 'Задача', tone: 'iris' }
  return { label: action, tone: 'muted' }
}

export function LogsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [fAction, setFAction] = useState('')

  const load = async () => {
    try { setEntries(await fetchAudit({ limit: 300 })) }
    catch (err) { pushToast({ type: 'error', title: 'Не удалось загрузить логи', desc: err instanceof Error ? err.message : '' }) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    const id = setInterval(() => { void load() }, 8000)
    return () => clearInterval(id)
  }, [])

  const actions = useMemo(() => [...new Set(entries.map((e) => e.action))], [entries])
  const filtered = fAction ? entries.filter((e) => e.action === fAction) : entries

  return (
    <div>
      <PageHeader
        title="Логи"
        subtitle="Единый журнал действий: смена статусов аккаунтов, старт/стоп задач, перенос профилей, кампании — с инициатором и причиной."
        icon={<ScrollText size={22} />}
        badge={entries.length ? `${entries.length}` : undefined}
        actions={<button onClick={() => void load()} className="btn-ghost h-10"><RefreshCw size={16} /> Обновить</button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={fAction} onChange={setFAction} className="w-56" options={[{ value: '', label: 'Все действия' }, ...actions.map((a) => ({ value: a, label: actionMeta(a).label + ` (${a})` }))]} />
      </div>

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ScrollText size={26} />} title="Логов пока нет" desc="Здесь появятся действия: смена статусов, запуск/остановка задач, переносы, кампании." />
      ) : (
        <div className="flex flex-col gap-1">
          {filtered.map((e) => {
            const am = actionMeta(e.action)
            const accs = (e.scope?.accounts as string[] | undefined)?.length
            return (
              <Card key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-sm">
                <Badge tone={am.tone}>{am.label}</Badge>
                <span className="text-white/80">{e.reason || e.code || e.action}</span>
                <div className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-white/40">
                  {e.module && e.module !== 'core' && <span>{e.module}</span>}
                  <span>кто: {e.initiator}</span>
                  {e.account && <span>акк: {String(e.account).slice(-6)}</span>}
                  {accs ? <span>{accs} акк.</span> : null}
                  <span>{new Date(e.ts).toLocaleString()}</span>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
