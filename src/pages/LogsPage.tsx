import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ScrollText, RefreshCw, Columns3, Search, Download, LogIn, LogOut, ShieldCheck, ShieldAlert,
  UserCog, Activity, ArrowLeftRight, Play, Square, ListChecks, Rocket, Mail, Flame, Network,
} from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Badge, Modal, Segmented } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { fetchAudit, type AuditEntry } from '@/api/auditApi'
import { fetchUsers } from '@/api/usersApi'
import { useSession } from '@/features/auth/session'
import { cn } from '@/shared/lib/utils'

type Tone = 'spark' | 'iris' | 'amber' | 'rose' | 'muted'

// Человеческие подписи, тон и иконка по типу действия (иначе видны сырые коды типа user.login).
function actionMeta(action: string): { label: string; tone: Tone; icon: ReactNode } {
  const i = (I: typeof LogIn) => <I size={13} />
  if (action === 'user.login') return { label: 'Вход', tone: 'spark', icon: i(LogIn) }
  if (action === 'user.login.fail') return { label: 'Неудачный вход', tone: 'rose', icon: i(ShieldAlert) }
  if (action === 'user.logout') return { label: 'Выход', tone: 'muted', icon: i(LogOut) }
  if (action.startsWith('role')) return { label: 'Роль', tone: 'iris', icon: i(ShieldCheck) }
  if (action.startsWith('user')) return { label: 'Пользователь', tone: 'iris', icon: i(UserCog) }
  if (action.startsWith('account.status')) return { label: 'Статус аккаунта', tone: 'amber', icon: i(Activity) }
  if (action.startsWith('account.transfer')) return { label: 'Перенос профиля', tone: 'iris', icon: i(ArrowLeftRight) }
  if (action.startsWith('account')) return { label: 'Аккаунт', tone: 'amber', icon: i(Activity) }
  if (action.startsWith('campaign')) return { label: 'Кампания', tone: 'spark', icon: i(Rocket) }
  if (action.startsWith('task.start')) return { label: 'Старт задачи', tone: 'spark', icon: i(Play) }
  if (action.startsWith('task.stop')) return { label: 'Стоп задачи', tone: 'muted', icon: i(Square) }
  if (action.startsWith('task')) return { label: 'Задача', tone: 'iris', icon: i(ListChecks) }
  if (action.startsWith('mailing')) return { label: 'Мейлинг', tone: 'iris', icon: i(Mail) }
  if (action.startsWith('warming')) return { label: 'Прогрев', tone: 'amber', icon: i(Flame) }
  if (action.startsWith('proxy')) return { label: 'Прокси', tone: 'iris', icon: i(Network) }
  return { label: action, tone: 'muted', icon: i(ScrollText) }
}

/** CSV из записей лога (для экспорта/отчётности). */
function logsToCsv(rows: AuditEntry[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = ['Время', 'Действие', 'Код', 'Инициатор', 'Модуль', 'Аккаунт', 'Причина']
  const body = rows.map((e) => [
    new Date(e.ts).toLocaleString(), actionMeta(e.action).label, e.action,
    e.initiator ?? '', e.module ?? '', e.account ?? '', e.reason ?? '',
  ].map(esc).join(','))
  return '﻿' + head.join(',') + '\n' + body.join('\n')
}

export function LogsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [fAction, setFAction] = useState('')
  const [fInitiator, setFInitiator] = useState('')
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const [mode, setMode] = useState(0) // 0 — список, 1 — потоки (2–3 колонки)
  const [streamActions, setStreamActions] = useState<string[]>([]) // до 3 действий-колонок

  /*
   * Чья это запись — видно прямо в строке (вопрос владельца 27.08: «почему я вижу все
   * логи всех пользователей, а не только свои и своих субпользователей?»).
   *
   * Сервер журнал уже режет: владельцу отдаются только его записи и записи его
   * сотрудников. Но в строке стоял голый e-mail или id — по нему не отличить своего
   * сотрудника от постороннего, и любой незнакомый адрес читается как утечка. Подписываем
   * «вы» и «сотрудник»; если вдруг появится кто-то ещё — это будет видно сразу, а не
   * потеряется среди сотни строк.
   */
  const me = useSession((st) => st.user)
  const [team, setTeam] = useState<{ id: string; email: string }[]>([])
  useEffect(() => {
    void fetchUsers().then((us) => setTeam(us.map((u) => ({ id: u.id, email: u.email })))).catch(() => {})
  }, [])

  const whoIs = (initiator?: string) => {
    const v = String(initiator || '').toLowerCase()
    if (!v) return null
    if (v === String(me?.id || '').toLowerCase() || v === String(me?.email || '').toLowerCase()) return 'вы'
    const mine = team.find((u) => u.id.toLowerCase() === v || (u.email || '').toLowerCase() === v)
    if (mine && mine.id !== me?.id) return 'сотрудник'
    return mine ? 'вы' : null
  }

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
  const matchesQ = (e: AuditEntry) => !q || `${e.action} ${e.reason ?? ''} ${e.initiator ?? ''} ${e.module ?? ''} ${actionMeta(e.action).label}`.toLowerCase().includes(q.toLowerCase())
  const filtered = entries.filter((e) => (!fAction || e.action === fAction) && byInitiator(e) && matchesQ(e))

  const exportCsv = () => {
    if (!filtered.length) { pushToast({ type: 'info', title: 'Нечего экспортировать' }); return }
    const blob = new Blob([logsToCsv(filtered)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `logs-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url)
    pushToast({ type: 'success', title: 'Экспорт CSV', desc: `${filtered.length} записей` })
  }

  // Потоки: выбор до 3 действий-колонок для параллельного просмотра (§3.1).
  const toggleStream = (a: string) => setStreamActions((prev) =>
    prev.includes(a) ? prev.filter((x) => x !== a) : prev.length >= 3 ? prev : [...prev, a])

  function renderEntry(e: AuditEntry) {
    const am = actionMeta(e.action)
    const accs = (e.scope?.accounts as string[] | undefined)?.length
    return (
      <button key={e.id} onClick={() => setDetail(e)} className="w-full text-left">
        <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-sm hover:border-white/20">
          <Badge tone={am.tone}><span className="inline-flex items-center gap-1">{am.icon} {am.label}</span></Badge>
          <span className="text-white/80">{e.reason || e.code || e.action}</span>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-white/40">
            {e.module && e.module !== 'core' && <span>{e.module}</span>}
            <span>
              кто: {e.initiator}
              {(() => {
                const кто = whoIs(e.initiator)
                if (!кто) return null
                return (
                  <span className={cn('ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    кто === 'вы' ? 'bg-spark-500/15 text-spark-300' : 'bg-iris-500/15 text-iris-300')}>
                    {кто}
                  </span>
                )
              })()}
            </span>
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
        subtitle="Ваши действия и действия ваших сотрудников: смена статусов аккаунтов, старт/стоп задач, кампании — с инициатором и причиной. (Администратор видит журнал всего пространства.)"
        icon={<ScrollText size={22} />}
        badge={entries.length ? `${entries.length}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <HelpButton topic="logs" className="h-10 w-10" />
            <button onClick={exportCsv} className="btn-ghost h-10"><Download size={16} /> CSV</button>
            <button onClick={() => void load()} className="btn-ghost h-10"><RefreshCw size={16} /> Обновить</button>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} size="sm" options={['Список', 'Потоки']} />
        {mode === 0 && <Select value={fAction} onChange={setFAction} className="w-56" options={[{ value: '', label: 'Все действия' }, ...actions.map((a) => ({ value: a, label: actionMeta(a).label + ` (${a})` }))]} />}
        <Select value={fInitiator} onChange={setFInitiator} className="w-44" options={[{ value: '', label: 'Все инициаторы' }, ...initiators.map((i) => ({ value: i, label: i }))]} />
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input h-9 pl-9" placeholder="Поиск по журналу…" />
        </div>
        {mode === 0 && <span className="text-xs text-white/40">Показано: {filtered.length}</span>}
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
