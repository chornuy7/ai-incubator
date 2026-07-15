import { useEffect, useMemo, useState } from 'react'
import { ScrollText, RefreshCw, Columns3 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Badge, Modal, Segmented } from '@/shared/ui'
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
  const [fInitiator, setFInitiator] = useState('')
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const [mode, setMode] = useState(0) // 0 — список, 1 — потоки (2–3 колонки)
  const [streamActions, setStreamActions] = useState<string[]>([]) // до 3 действий-колонок

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
  const initiators = useMemo(() => [...new Set(entries.map((e) => e.initiator).filter((x): x is string => !!x))], [entries])
  const byInitiator = (e: AuditEntry) => !fInitiator || e.initiator === fInitiator
  const filtered = entries.filter((e) => (!fAction || e.action === fAction) && byInitiator(e))

  // Потоки: выбор до 3 действий-колонок для параллельного просмотра (§3.1).
  const toggleStream = (a: string) => setStreamActions((prev) =>
    prev.includes(a) ? prev.filter((x) => x !== a) : prev.length >= 3 ? prev : [...prev, a])

  function renderEntry(e: AuditEntry) {
    const am = actionMeta(e.action)
    const accs = (e.scope?.accounts as string[] | undefined)?.length
    return (
      <button key={e.id} onClick={() => setDetail(e)} className="w-full text-left">
        <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-sm hover:border-white/20">
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
      </button>
    )
  }

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
        <Segmented value={mode} onChange={setMode} size="sm" options={['Список', 'Потоки']} />
        {mode === 0 && <Select value={fAction} onChange={setFAction} className="w-56" options={[{ value: '', label: 'Все действия' }, ...actions.map((a) => ({ value: a, label: actionMeta(a).label + ` (${a})` }))]} />}
        <Select value={fInitiator} onChange={setFInitiator} className="w-44" options={[{ value: '', label: 'Все инициаторы' }, ...initiators.map((i) => ({ value: i, label: i }))]} />
      </div>

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : mode === 1 ? (
        // Потоки: параллельный просмотр 2–3 действий колонками (§3.1).
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-xs text-white/40"><Columns3 size={13} /> Колонки (до 3):</span>
            {actions.map((a) => {
              const on = streamActions.includes(a)
              const disabled = !on && streamActions.length >= 3
              return (
                <button key={a} onClick={() => toggleStream(a)} disabled={disabled}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${on ? 'bg-spark-500/15 text-spark-300 ring-1 ring-inset ring-spark-500/40' : disabled ? 'cursor-not-allowed text-white/25' : 'bg-elevated text-white/60 hover:text-fg'}`}>
                  {actionMeta(a).label}
                </button>
              )
            })}
          </div>
          {streamActions.length === 0 ? (
            <EmptyState icon={<Columns3 size={26} />} title="Выберите потоки" desc="Отметьте 2–3 действия выше — они откроются параллельными колонками для сравнения." />
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${streamActions.length}, minmax(0, 1fr))` }}>
              {streamActions.map((a) => {
                const col = entries.filter((e) => e.action === a && byInitiator(e))
                return (
                  <div key={a} className="min-w-0">
                    <div className="mb-2 flex items-center gap-2 border-b border-line pb-1.5">
                      <Badge tone={actionMeta(a).tone}>{actionMeta(a).label}</Badge>
                      <span className="text-xs text-white/40">{col.length}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {col.length === 0 ? <span className="px-1 text-xs text-white/30">пусто</span> : col.map(renderEntry)}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ScrollText size={26} />} title="Логов пока нет" desc="Здесь появятся действия: смена статусов, запуск/остановка задач, переносы, кампании." />
      ) : (
        <div className="flex flex-col gap-1">
          {filtered.map(renderEntry)}
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Запись лога" subtitle={detail?.action} icon={<ScrollText size={20} />} size="md">
        {detail && (
          <div className="space-y-2 text-sm">
            {([
              ['Действие', actionMeta(detail.action).label + ` (${detail.action})`],
              ['Инициатор', detail.initiator],
              ['Модуль', detail.module],
              ['Код', detail.code || '—'],
              ['Причина', detail.reason || '—'],
              ['Аккаунт', detail.account || '—'],
              ['Время', new Date(detail.ts).toLocaleString()],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="w-28 shrink-0 text-white/40">{k}</span>
                <span className="text-white/90">{v}</span>
              </div>
            ))}
            {detail.meta && (
              <div className="flex gap-2">
                <span className="w-28 shrink-0 text-white/40">Детали</span>
                <span className="text-white/70">
                  {detail.meta.from != null && detail.meta.to != null ? `${detail.meta.from} → ${detail.meta.to}` : JSON.stringify(detail.meta)}
                </span>
              </div>
            )}
            {Array.isArray(detail.scope?.accounts) && (detail.scope.accounts as string[]).length > 0 && (
              <div className="flex gap-2">
                <span className="w-28 shrink-0 text-white/40">Затронуто</span>
                <span className="text-white/70">{(detail.scope.accounts as string[]).length} акк.: {(detail.scope.accounts as string[]).map((a) => a.slice(-6)).join(', ')}</span>
              </div>
            )}
            {detail.scope?.taskId != null && (
              <div className="flex gap-2"><span className="w-28 shrink-0 text-white/40">Задача</span><span className="font-mono text-xs text-white/70">{String(detail.scope.taskId)}</span></div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
