import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LifeBuoy, Plus, Send, MessageSquare, Clock, Loader2, ArrowLeft } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Modal, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { fetchTickets, fetchTicket, createTicket, replyTicket, type ApiTicket, type TicketStatus } from '@/api/ticketsApi'

const STATUS_META: Record<TicketStatus, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  open: { label: 'Открыт', tone: 'spark' },
  progress: { label: 'В работе', tone: 'iris' },
  waiting: { label: 'Ожидает ответа', tone: 'amber' },
  escalated: { label: 'Эскалирован', tone: 'rose' },
  closed: { label: 'Закрыт', tone: 'muted' },
}
const FILTERS = [
  { value: 'all', label: 'Все статусы' },
  { value: 'open', label: 'Открыт' },
  { value: 'progress', label: 'В работе' },
  { value: 'waiting', label: 'Ожидает ответа' },
  { value: 'escalated', label: 'Эскалирован' },
  { value: 'closed', label: 'Закрыт' },
]

const fmtTs = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
const preview = (t: ApiTicket) => t.messages.length ? t.messages[t.messages.length - 1].text : t.subject

/**
 * §8 (MR-44): тикеты поддержки теперь с сервера — переписка живёт на бэкенде и видна
 * в админ-панели (вкладка «Тикеты»). Раньше это был мок в браузере, поддержка их не
 * видела. Клиент создаёт обращение, переписывается; статусы двигает поддержка из админки.
 */
export function SupportPage() {
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)
  const [tickets, setTickets] = useState<ApiTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState('tech')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [openTicket, setOpenTicket] = useState<ApiTicket | null>(null)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [params, setParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setTickets(await fetchTickets()) } catch { /* API недоступен — пусто */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  // §8 (MR-45): виджет поддержки открывает «Новый тикет» сразу — по ?new=1.
  useEffect(() => {
    if (params.get('new') === '1') { setNewOpen(true); params.delete('new'); setParams(params, { replace: true }) }
  }, [params, setParams])

  const filtered = filter === 'all' ? tickets : tickets.filter((t) => t.status === filter)

  const submitTicket = async () => {
    if (!subject.trim()) return pushToast({ type: 'error', title: 'Укажите тему обращения' })
    if (!guardNet('создание тикета')) return
    setSaving(true)
    try {
      await createTicket({ subject: subject.trim(), category, body: body.trim() })
      pushToast({ type: 'success', title: 'Тикет создан', desc: 'Поддержка ответит в течение 24 часов.' })
      setNewOpen(false); setSubject(''); setBody(''); setCategory('tech')
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' }) }
    finally { setSaving(false) }
  }

  const openThread = async (t: ApiTicket) => {
    setOpenTicket(t); setReply('')
    try { setOpenTicket(await fetchTicket(t.id)) } catch { /* оставляем то, что есть в списке */ }
  }

  const sendReply = async () => {
    if (!openTicket || !reply.trim()) return
    setReplying(true)
    try {
      const updated = await replyTicket(openTicket.id, reply.trim())
      setOpenTicket(updated); setReply('')
      setTickets((list) => list.map((x) => x.id === updated.id ? updated : x))
    } catch (e) { pushToast({ type: 'error', title: 'Не отправлено', desc: e instanceof Error ? e.message : '' }) }
    finally { setReplying(false) }
  }

  // §8: «Новый тикет» — ОТДЕЛЬНЫЙ ЭКРАН, а не попап поверх списка. Форма обращения —
  // это работа, а не подтверждение: модалка сжимала её в окошко, перекрывала список и
  // терялась при случайном клике мимо. Здесь та же страница, только вместо списка форма.
  if (newOpen) {
    return (
      <div>
        <button onClick={() => setNewOpen(false)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к обращениям</button>
        <PageHeader
          title="Новый тикет"
          subtitle="Опишите проблему — команда ответит в течение суток"
          icon={<LifeBuoy size={22} />}
        />
        <Card className="max-w-2xl space-y-4 p-5">
          <div>
            <label className="label">Тема</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input" placeholder="Кратко о проблеме" autoFocus />
          </div>
          <div>
            <label className="label">Категория</label>
            <Select value={category} onChange={setCategory} options={[
              { value: 'tech', label: 'Технический вопрос' },
              { value: 'billing', label: 'Оплата и тариф' },
              { value: 'accounts', label: 'Аккаунты и прокси' },
            ]} />
          </div>
          <div>
            <label className="label">Сообщение</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="input resize-y" placeholder="Подробное описание: что делали, что ожидали, что получилось…" />
          </div>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button onClick={() => setNewOpen(false)} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void submitTicket()} disabled={saving} className="btn-primary h-10 disabled:opacity-50">
              {saving ? <Loader2 size={16} className="animate-spin" /> : null} Создать тикет
            </button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Поддержка"
        subtitle="Тикеты и связь с командой Murmex"
        icon={<LifeBuoy size={22} />}
        actions={<>
          <HelpButton topic="support" className="h-10 w-10" />
          <button onClick={() => pushToast({ type: 'info', title: 'Открываю Telegram', desc: '@ai_incubator_support (демо).' })} className="btn-ghost h-10"><Send size={16} /> Написать в Telegram</button>
          <button onClick={() => setNewOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый тикет</button>
        </>}
      />

      <div className="mb-4 flex items-center gap-2">
        <Select className="w-52" value={filter} onChange={setFilter} options={FILTERS} />
        <span className="text-sm text-muted">Найдено: {filtered.length}</span>
      </div>

      {loading ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> Загрузка тикетов…</Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<LifeBuoy size={26} />}
            title="У вас пока нет тикетов"
            desc="Создайте обращение — команда поддержки ответит в течение суток."
            action={<button onClick={() => setNewOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый тикет</button>}
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((t) => {
            const m = STATUS_META[t.status]
            return (
              <button key={t.id} onClick={() => void openThread(t)} className="card flex w-full items-center gap-4 p-4 text-left transition-colors hover:border-spark-500/30">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-elevated text-muted"><MessageSquare size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">{t.id}</span>
                    <Badge tone={m.tone}>{m.label}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-semibold text-fg">{t.subject}</div>
                  <div className="truncate text-xs text-muted">{preview(t)}</div>
                </div>
                <div className="hidden shrink-0 flex-col items-end gap-1 text-xs text-muted sm:flex">
                  <span className="flex items-center gap-1"><Clock size={12} /> {fmtTs(t.updatedAt)}</span>
                  <span className="flex items-center gap-1"><MessageSquare size={12} /> {t.messages.length}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Ticket thread */}
      <Modal open={!!openTicket} onClose={() => setOpenTicket(null)} title={openTicket?.subject} subtitle={openTicket?.id} icon={<MessageSquare size={22} />} size="md">
        {openTicket && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_META[openTicket.status].tone}>{STATUS_META[openTicket.status].label}</Badge>
              <span className="text-xs text-muted">Обновлён {fmtTs(openTicket.updatedAt)}</span>
            </div>
            <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
              {openTicket.messages.length === 0 ? (
                <div className="rounded-xl border border-line bg-elevated p-3.5 text-sm text-muted">Пока нет сообщений. Напишите первым.</div>
              ) : openTicket.messages.map((msg) => (
                <div key={msg.id} className={msg.from === 'support'
                  ? 'rounded-xl border border-spark-500/25 bg-spark-500/8 p-3.5 text-sm text-fg'
                  : 'rounded-xl border border-line bg-elevated p-3.5 text-sm text-fg'}>
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                    <span className={msg.from === 'support' ? 'font-semibold text-spark-300' : 'font-semibold text-fg'}>
                      {msg.from === 'support' ? 'Поддержка' : 'Вы'}
                    </span>
                    <span>· {fmtTs(msg.ts)}</span>
                  </div>
                  <div className="whitespace-pre-wrap">{msg.text}</div>
                </div>
              ))}
            </div>
            {openTicket.status === 'closed' ? (
              <div className="rounded-xl border border-line bg-surface p-3 text-center text-xs text-muted">Тикет закрыт. Новый ответ откроет его снова.</div>
            ) : null}
            <div className="flex gap-2 pt-1">
              <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void sendReply()} className="input flex-1" placeholder="Ваш ответ…" />
              <button onClick={() => void sendReply()} disabled={replying || !reply.trim()} className="btn-primary h-[42px] px-4 disabled:opacity-50">
                {replying ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
