import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Smile, MessagesSquare, MessageCircle, Send, UserPlus, FileText, ExternalLink, Activity, ListChecks } from 'lucide-react'
import { fetchAccountActions, type AccountAction, type AccountActionType } from '@/api/accountsApi'
import { Select } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'

/**
 * MR-122 (LOG-003): история аккаунта. Все действия, что он совершил в Telegram —
 * посты, комментарии, реакции, чаты, диалоги, вступления — из журнала действий (LOG-002).
 *
 * Владелец покупает аккаунт и должен видеть НЕ только сводку («сделал 800 действий» —
 * это вкладка «Работа»), а что именно и где: под каким постом комментировал, в какой
 * группе отвечал, куда вступил. Ссылка открывает сам объект в Telegram.
 *
 * Фильтры (тип / группа / период) применяем на клиенте по уже загруженному окну: история
 * одного аккаунта не бесконечна, а мгновенный отклик важнее, чем экономия на дозагрузке.
 */
const TYPE_META: Record<AccountActionType, { label: string; icon: React.ReactNode; tone: string }> = {
  post:     { label: 'Пост',        icon: <FileText size={13} />,       tone: 'text-iris-300' },
  comment:  { label: 'Комментарий', icon: <MessageSquare size={13} />,  tone: 'text-spark-300' },
  reaction: { label: 'Реакция',     icon: <Smile size={13} />,          tone: 'text-amber-300' },
  chat:     { label: 'Чат',         icon: <MessagesSquare size={13} />, tone: 'text-emerald-300' },
  dialog:   { label: 'Диалог (ЛС)', icon: <MessageCircle size={13} />,  tone: 'text-emerald-300' },
  dm:       { label: 'Рассылка',    icon: <Send size={13} />,           tone: 'text-emerald-300' },
  join:     { label: 'Вступление',  icon: <UserPlus size={13} />,       tone: 'text-iris-300' },
  action:   { label: 'Действие',    icon: <Activity size={13} />,       tone: 'text-muted' },
}

const PERIODS: { value: string; label: string; ms: number }[] = [
  { value: '', label: 'Всё время', ms: 0 },
  { value: 'today', label: 'Сегодня', ms: 24 * 3600e3 },
  { value: '7d', label: '7 дней', ms: 7 * 24 * 3600e3 },
  { value: '30d', label: '30 дней', ms: 30 * 24 * 3600e3 },
]

export function HistoryTab({ accountId }: { accountId: string }) {
  const [actions, setActions] = useState<AccountAction[] | null>(null)
  const [err, setErr] = useState('')
  const [fType, setFType] = useState('')
  const [fTarget, setFTarget] = useState('')
  const [fPeriod, setFPeriod] = useState('')

  useEffect(() => {
    let alive = true
    setActions(null); setErr('')
    void fetchAccountActions(accountId, { limit: 1000 })
      .then((a) => { if (alive) setActions(a) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Не удалось загрузить историю') })
    return () => { alive = false }
  }, [accountId])

  // Список групп/каналов для фильтра — из того, что реально есть в истории.
  const targets = useMemo(() => [...new Set((actions || []).map((a) => a.target).filter(Boolean))].sort(), [actions])
  const types = useMemo(() => [...new Set((actions || []).map((a) => a.type))], [actions])

  const filtered = useMemo(() => {
    const period = PERIODS.find((p) => p.value === fPeriod)
    const from = period && period.ms ? Date.now() - period.ms : 0
    return (actions || []).filter((a) =>
      (!fType || a.type === fType) &&
      (!fTarget || a.target === fTarget) &&
      (!from || (Date.parse(a.ts) || 0) >= from),
    )
  }, [actions, fType, fTarget, fPeriod])

  if (err) return <div className="p-4 text-sm text-red-300">{err}</div>
  if (!actions) return <div className="p-4 text-sm text-muted">Загрузка…</div>

  return (
    <div className="space-y-3">
      {/* Фильтры: тип · группа/канал · период (MR-122). */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={fType} onChange={setFType} className="w-44"
          options={[{ value: '', label: 'Все типы' }, ...types.map((t) => ({ value: t, label: TYPE_META[t]?.label || t }))]} />
        <Select value={fTarget} onChange={setFTarget} className="w-52"
          options={[{ value: '', label: 'Все группы/каналы' }, ...targets.map((t) => ({ value: t, label: t }))]} />
        <Select value={fPeriod} onChange={setFPeriod} className="w-36"
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
        <span className="ml-auto text-xs text-muted">{filtered.length} из {actions.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-elevated/40 py-10 text-center">
          <ListChecks size={26} className="text-muted" />
          <div className="text-sm font-semibold text-fg">{actions.length === 0 ? 'Действий пока нет' : 'Ничего под фильтр'}</div>
          <div className="max-w-xs text-xs text-muted">
            {actions.length === 0
              ? 'Как только аккаунт отработает в модуле (комментарий, реакция, чат, вступление) — действия появятся здесь.'
              : 'Смягчите фильтры — по другим типам или периоду действия есть.'}
          </div>
        </div>
      ) : (
        <div className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">
          {filtered.map((a) => <ActionRow key={a.id} a={a} />)}
        </div>
      )}
    </div>
  )
}

function ActionRow({ a }: { a: AccountAction }) {
  const m = TYPE_META[a.type] || TYPE_META.action
  const url = a.objectRef?.url
  // Что показать как «содержимое»: текст (коммент/чат/диалог) или эмодзи (реакция).
  const body = a.value?.emoji || a.value?.text || ''
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-elevated', m.tone)}>{m.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn('text-xs font-bold', m.tone)}>{m.label}</span>
          {a.target && <span className="truncate text-sm font-medium text-fg">{a.target}</span>}
          {a.objectRef?.postId ? <span className="font-mono text-[11px] text-muted">пост #{a.objectRef.postId}</span> : null}
          {a.status && a.status !== 'sent' && <span className="text-[11px] text-amber-300">{a.status}</span>}
        </div>
        {body && <div className="mt-0.5 truncate text-xs text-white/60" title={body}>{body}</div>}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          <span>{new Date(a.ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {a.moduleKey && <span>· {a.moduleKey}</span>}
          {!!(a.audience?.reactionsCount || a.audience?.repliesCount) && (
            <span className="text-emerald-300/70">· отклик: {a.audience?.reactionsCount || 0} реакц. / {a.audience?.repliesCount || 0} отв.</span>
          )}
        </div>
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="btn-icon mt-0.5 h-7 w-7 shrink-0 text-muted hover:text-spark-300" title="Открыть объект в Telegram">
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  )
}
