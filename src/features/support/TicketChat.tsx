import { cn } from '@/shared/lib/utils'
import type { ApiTicket } from '@/api/ticketsApi'

const fmtTs = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

/**
 * Переписка тикета «как в мессенджере»: пузыри выровнены по стороне отправителя.
 * `viewerIsSupport` — смотрит поддержка (тогда «мои» — сообщения поддержки, справа)
 * или клиент (тогда «мои» — от клиента). Автор подписан ИМЕНЕМ (мейл клиента /
 * «Поддержка»), а не ролью-заглушкой — это и была суть жалобы.
 */
export function TicketChat({ ticket, viewerIsSupport }: { ticket: ApiTicket; viewerIsSupport: boolean }) {
  const messages = ticket.messages || []
  if (messages.length === 0) {
    return <div className="rounded-xl border border-line bg-elevated p-3.5 text-sm text-muted">Пока нет сообщений. Напишите первым.</div>
  }
  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => {
        const isSupportMsg = m.from === 'support'
        const mine = viewerIsSupport ? isSupportMsg : !isSupportMsg
        const name = isSupportMsg ? 'Поддержка' : (m.authorName || ticket.ownerName || ticket.ownerEmail || 'Клиент')
        return (
          <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[80%] rounded-2xl border px-3.5 py-2 text-sm shadow-sm',
              mine
                ? 'rounded-br-sm border-spark-500/30 bg-spark-500/12'
                : 'rounded-bl-sm border-line bg-elevated',
            )}>
              <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                <span className={cn('font-semibold', isSupportMsg ? 'text-spark-300' : 'text-iris-300')}>{name}</span>
                <span className="text-muted">{fmtTs(m.ts)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-fg">{m.text}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
