import { useState } from 'react'
import { LifeBuoy, Plus, Send, MessageSquare, Clock } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Select, Modal, Badge } from '@/shared/ui'
import type { Ticket, TicketStatus } from '@/shared/types'

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

export function SupportPage() {
  const tickets = useApp((s) => s.data.tickets)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)
  const [filter, setFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [openTicket, setOpenTicket] = useState<Ticket | null>(null)

  const filtered = filter === 'all' ? tickets : tickets.filter((t) => t.status === filter)

  const createTicket = () => {
    if (!subject.trim()) return pushToast({ type: 'error', title: 'Укажите тему обращения' })
    if (!guardNet('создание тикета')) return
    pushToast({ type: 'success', title: 'Тикет создан', desc: 'Мы ответим в течение 24 часов (демо).' })
    setNewOpen(false); setSubject(''); setBody('')
  }

  return (
    <div>
      <PageHeader
        title="Поддержка"
        subtitle="Тикеты и связь с командой AI Incubator"
        icon={<LifeBuoy size={22} />}
        actions={<>
          <button onClick={() => pushToast({ type: 'info', title: 'Открываю Telegram', desc: '@ai_incubator_support (демо).' })} className="btn-ghost h-10"><Send size={16} /> Написать в Telegram</button>
          <button onClick={() => setNewOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый тикет</button>
        </>}
      />

      <div className="mb-4 flex items-center gap-2">
        <Select className="w-52" value={filter} onChange={setFilter} options={FILTERS} />
        <span className="text-sm text-muted">Найдено: {filtered.length}</span>
      </div>

      {filtered.length === 0 ? (
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
              <button key={t.id} onClick={() => setOpenTicket(t)} className="card flex w-full items-center gap-4 p-4 text-left transition-colors hover:border-spark-500/30">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-elevated text-muted"><MessageSquare size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">{t.id}</span>
                    <Badge tone={m.tone}>{m.label}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-semibold text-fg">{t.subject}</div>
                  <div className="truncate text-xs text-muted">{t.preview}</div>
                </div>
                <div className="hidden shrink-0 flex-col items-end gap-1 text-xs text-muted sm:flex">
                  <span className="flex items-center gap-1"><Clock size={12} /> {t.updatedAt}</span>
                  <span className="flex items-center gap-1"><MessageSquare size={12} /> {t.messages}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* New ticket */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Новый тикет"
        subtitle="Опишите проблему — приложите детали"
        icon={<LifeBuoy size={22} />}
        footer={<>
          <button onClick={() => setNewOpen(false)} className="btn-ghost h-10">Отмена</button>
          <button onClick={createTicket} className="btn-primary h-10">Создать тикет</button>
        </>}
      >
        <div className="space-y-4">
          <div>
            <label className="label">Тема</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input" placeholder="Кратко о проблеме" />
          </div>
          <div>
            <label className="label">Категория</label>
            <Select value="tech" onChange={() => {}} options={[
              { value: 'tech', label: 'Технический вопрос' },
              { value: 'billing', label: 'Оплата и тариф' },
              { value: 'accounts', label: 'Аккаунты и прокси' },
            ]} />
          </div>
          <div>
            <label className="label">Сообщение</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="input resize-none" placeholder="Подробное описание…" />
          </div>
        </div>
      </Modal>

      {/* Ticket view */}
      <Modal open={!!openTicket} onClose={() => setOpenTicket(null)} title={openTicket?.subject} subtitle={openTicket?.id} icon={<MessageSquare size={22} />} size="md">
        {openTicket && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_META[openTicket.status].tone}>{STATUS_META[openTicket.status].label}</Badge>
              <span className="text-xs text-muted">Обновлён {openTicket.updatedAt}</span>
            </div>
            <div className="rounded-xl border border-line bg-elevated p-3.5 text-sm text-fg">{openTicket.preview}</div>
            <div className="rounded-xl border border-line bg-surface p-3.5 text-sm text-muted">
              <span className="font-semibold text-spark-300">Поддержка:</span> Спасибо за обращение! Мы разбираемся с вопросом и вернёмся с ответом. (демо-переписка)
            </div>
            <div className="flex gap-2 pt-1">
              <input className="input flex-1" placeholder="Ваш ответ…" />
              <button onClick={() => pushToast({ type: 'success', title: 'Ответ отправлен (демо)' })} className="btn-primary h-[42px] px-4"><Send size={16} /></button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
