import { useEffect, useState } from 'react'
import { MessageSquare, RefreshCw, AlertTriangle, Bot, User } from 'lucide-react'
import { Modal, Badge } from '@/shared/ui'
import { fetchLeadConversation, type Lead, type LeadConversation } from '@/api/leadsApi'
import { cn } from '@/shared/lib/utils'

/**
 * Переписка с лидом целиком: что написали мы и что ответил человек.
 *
 * Читается из самого Telegram аккаунтом-владельцем лида, а не из логов задачи —
 * в логах видно только наши реплики, а понять, как построился разговор, можно
 * лишь по обеим сторонам. Поэтому работает и для лидов из прошлых прогонов.
 */
export function LeadConversationModal({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const [data, setData] = useState<LeadConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async (id: string) => {
    setLoading(true); setError('')
    try {
      setData(await fetchLeadConversation(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось прочитать переписку')
      setData(null)
    } finally { setLoading(false) }
  }

  useEffect(() => {
    if (lead) void load(lead.id)
    else { setData(null); setError('') }
  }, [lead?.id])

  const messages = data?.messages?.messages || []

  return (
    <Modal
      open={!!lead}
      onClose={onClose}
      title={`Переписка · ${lead?.peer || ''}`}
      subtitle={data ? `Аккаунт ${data.account.name}` : 'Читаем диалог из Telegram…'}
      icon={<MessageSquare size={18} />}
      size="lg"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {lead?.goalId && <Badge tone="iris">по цели</Badge>}
          {data?.busyIn && (
            <Badge tone="amber" >
              Аккаунт сейчас занят: {data.busyIn.moduleLabel}
            </Badge>
          )}
          <button
            onClick={() => lead && void load(lead.id)}
            disabled={loading}
            className="btn-ghost ml-auto h-8 px-2 text-xs"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} /> Обновить
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Переписка недоступна</div>
              <div className="text-xs opacity-80">{error}</div>
            </div>
          </div>
        )}

        <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded-xl border border-line bg-elevated/30 p-3">
          {loading && !messages.length && <div className="py-8 text-center text-sm text-white/40">Загружаем диалог…</div>}
          {!loading && !messages.length && !error && (
            <div className="py-8 text-center text-sm text-white/40">
              Сообщений нет — с этим контактом ещё не переписывались.
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cn('flex gap-2', m.out ? 'justify-end' : 'justify-start')}>
              {!m.out && <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/8 text-white/50"><User size={12} /></span>}
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
                  // Наши реплики — справа и подсвечены: сразу видно, кто вёл разговор.
                  m.out ? 'bg-spark-500/15 text-spark-100' : 'bg-white/6 text-white/85',
                )}
              >
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                <div className="mt-1 text-[10px] opacity-45">{m.time}{m.media ? ` · ${m.media}` : ''}</div>
              </div>
              {m.out && <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-spark-500/15 text-spark-300"><Bot size={12} /></span>}
            </div>
          ))}
        </div>

        {data?.messages?.hasMore && (
          <p className="text-center text-[11px] text-white/35">Показаны последние {messages.length} сообщений</p>
        )}
      </div>
    </Modal>
  )
}
