import { useEffect, useState } from 'react'
import { MessageSquare, RefreshCw, AlertTriangle, Bot, User } from 'lucide-react'
import { Modal, Badge } from '@/shared/ui'
import { fetchLeadConversation, fetchConversationByPeer, type Lead, type LeadConversation } from '@/api/leadsApi'
import { cn } from '@/shared/lib/utils'

/**
 * Кого показываем: лида из CRM либо просто контакт с аккаунтом — получателя рассылки,
 * который лидом ещё не стал (задача могла идти без цели).
 */
export type ConversationSource =
  | { kind: 'lead'; lead: Lead }
  | { kind: 'peer'; peer: string; accountId: string }

/**
 * Переписка целиком: что написали мы и что ответил человек.
 *
 * Читается из самого Telegram аккаунтом, который вёл диалог, а не из логов задачи —
 * в логах видно только наши реплики, а понять, как построился разговор, можно
 * лишь по обеим сторонам. Поэтому работает и для прогонов, сделанных раньше.
 */
export function LeadConversationModal({ source, onClose }: { source: ConversationSource | null; onClose: () => void }) {
  const [data, setData] = useState<LeadConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const title = source?.kind === 'lead' ? source.lead.peer : source?.peer || ''
  const key = source?.kind === 'lead' ? source.lead.id : source ? `${source.accountId}:${source.peer}` : ''

  const load = async (src: ConversationSource) => {
    setLoading(true); setError('')
    try {
      setData(src.kind === 'lead'
        ? await fetchLeadConversation(src.lead.id)
        : await fetchConversationByPeer(src.peer, src.accountId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось прочитать переписку')
      setData(null)
    } finally { setLoading(false) }
  }

  useEffect(() => {
    if (source) void load(source)
    else { setData(null); setError('') }
  }, [key])

  const messages = data?.messages?.messages || []

  return (
    <Modal
      open={!!source}
      onClose={onClose}
      title={`Переписка · ${title}`}
      subtitle={data ? `Аккаунт ${data.account.name}` : 'Читаем диалог из Telegram…'}
      icon={<MessageSquare size={18} />}
      size="lg"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {data?.lead?.goalId && <Badge tone="iris">по цели</Badge>}
          {data?.busyIn && (
            <Badge tone="amber" >
              Аккаунт сейчас занят: {data.busyIn.moduleLabel}
            </Badge>
          )}
          <button
            onClick={() => source && void load(source)}
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
          {!loading && !messages.length && !error && !data?.wiped?.length && (
            <div className="py-8 text-center text-sm text-white/40">
              Сообщений нет — с этим контактом ещё не переписывались.
            </div>
          )}
          {!loading && !messages.length && !!data?.wiped?.length && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">Telegram не показывает эту переписку</div>
                  <div className="mt-0.5 opacity-85">
                    Отправка прошла, но ни сообщения, ни диалога у аккаунта больше нет — так выглядит
                    удаление антиспамом. Получатель его, скорее всего, не увидел. Это признак того,
                    что аккаунт помечен, а не ошибка отображения.
                  </div>
                </div>
              </div>
              {data.wiped.map((w, i) => (
                <div key={i} className="flex justify-end gap-2">
                  <div className="max-w-[75%] rounded-2xl border border-dashed border-white/15 bg-white/4 px-3 py-2 text-sm text-white/60">
                    <div className="whitespace-pre-wrap break-words">{w.text}</div>
                    <div className="mt-1 text-[10px] opacity-45">
                      отправляли {new Date(w.ts).toLocaleString('ru-RU')}
                    </div>
                  </div>
                </div>
              ))}
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
