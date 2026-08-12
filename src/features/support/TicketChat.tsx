import { cn } from '@/shared/lib/utils'
import type { ApiTicket, TicketMessage } from '@/api/ticketsApi'

const fmtTs = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

/** Короткий ID для подписи: длинные `usr_ae6505e0c5c5` жмём до `usr_…c5c5`. */
export function shortId(id?: string): string {
  const s = String(id || '').trim()
  if (!s || s === '—') return ''
  return s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s
}

/**
 * Кто написал сообщение. Главная подпись — ПОЧТА (имя в базе бывает ролевым:
 * «Администратор» ничего не говорит о человеке), имя — запасной вариант.
 */
function authorLabel(m: TicketMessage, ticket: ApiTicket): string {
  if (m.from === 'support') return 'Поддержка'
  return m.authorEmail || m.authorName || ticket.ownerEmail || ticket.ownerName || 'Клиент'
}

/**
 * Переписка тикета «как в мессенджере»: пузыри выровнены по стороне отправителя.
 * `viewerIsSupport` — смотрит поддержка (тогда «мои» — сообщения поддержки, справа)
 * или клиент (тогда «мои» — от клиента).
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
        const label = authorLabel(m, ticket)
        // ID показываем только у клиента — у поддержки он не нужен (подпись ролевая).
        const sid = isSupportMsg ? '' : shortId(m.authorId || ticket.userId)
        return (
          <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[80%] rounded-2xl border px-3.5 py-2 text-sm shadow-sm',
              mine
                ? 'rounded-br-sm border-spark-500/30 bg-spark-500/12'
                : 'rounded-bl-sm border-line bg-elevated',
            )}>
              <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                <span className={cn('truncate font-semibold', isSupportMsg ? 'text-spark-300' : 'text-iris-300')}>{label}</span>
                <span className="shrink-0 text-muted">{fmtTs(m.ts)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-fg">{m.text}</div>
              {/* Короткий ID автора — снизу, мелким: опознать человека, не загромождая подпись. */}
              {sid && <div className="mt-1 font-mono text-[10px] text-faint">ID {sid}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
