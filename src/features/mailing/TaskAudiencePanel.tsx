import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Copy, Check, Send, MessageSquare, ChevronDown } from 'lucide-react'
import { Badge } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { fetchTaskAudience, type AudienceRow, type TaskAudience } from '@/api/modulesApi'
import { LeadConversationModal, type ConversationSource } from '@/features/leads/LeadConversationModal'
import { cn } from '@/shared/lib/utils'

/**
 * Что передаём в модуль рассылки при переходе «в новую рассылку».
 * Через state навигации, а не sessionStorage: в dev-режиме React монтирует страницу
 * дважды, и «прочитать и удалить» на втором монтировании отдавало пустоту.
 */
export interface MailingPrefill { targets: string; fromTaskId: string }

type GroupKey = keyof TaskAudience

const GROUPS: { key: GroupKey; label: string; tone: 'spark' | 'amber' | 'rose' | 'muted'; hint: string }[] = [
  { key: 'sent', label: 'Написали', tone: 'spark', hint: 'Сообщение доставлено — этих в новую рассылку брать не надо' },
  { key: 'remaining', label: 'Не дошли', tone: 'muted', hint: 'До них очередь не дошла: задачу остановили или кончились лимиты и аккаунты' },
  { key: 'failed', label: 'Сорвалось', tone: 'rose', hint: 'Ошибка на нашей стороне (спамблок, приватность) — таких стоит взять снова' },
  { key: 'skipped', label: 'Нет в Telegram', tone: 'amber', hint: 'Такого пользователя не существует — брать повторно бессмысленно' },
]

/**
 * §9.11: кому написали и кто остался.
 *
 * После прогона счётчик говорит «35 из 1000», но не говорит КТО эти 35 — а без
 * этого повторная рассылка либо пишет людям второй раз, либо человек вручную
 * сверяет тысячу строк. Здесь списки можно скопировать и сразу отправить в новую
 * рассылку, а по каждому получателю — открыть переписку и посмотреть, как пошло.
 */
export function TaskAudiencePanel({ moduleKey, taskId }: { moduleKey: string; taskId: string }) {
  const navigate = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [audience, setAudience] = useState<TaskAudience | null>(null)
  const [total, setTotal] = useState(0)
  const [open, setOpen] = useState<GroupKey | null>('sent')
  const [copied, setCopied] = useState<GroupKey | null>(null)
  const [chat, setChat] = useState<ConversationSource | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchTaskAudience(moduleKey, taskId)
      .then((r) => { if (!cancelled) { setAudience(r.audience); setTotal(r.total) } })
      .catch(() => { /* панель необязательная — молча прячемся */ })
    return () => { cancelled = true }
  }, [moduleKey, taskId])

  /** Кого имеет смысл взять в следующий заход: не дошли + сорвалось. */
  const reusable = useMemo(
    () => (audience ? [...audience.remaining, ...audience.failed] : []),
    [audience],
  )

  if (!audience || !total) return null

  const copy = async (key: GroupKey, rows: AudienceRow[]) => {
    try {
      await navigator.clipboard.writeText(rows.map((r) => r.target).join('\n'))
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      pushToast({ type: 'error', title: 'Буфер обмена недоступен', desc: 'Скопируйте список вручную' })
    }
  }

  const toMailing = () => {
    const prefill: MailingPrefill = { targets: reusable.map((r) => r.target).join('\n'), fromTaskId: taskId }
    navigate('/panel/mailing', { state: prefill })
  }

  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Users size={15} className="text-iris-300" />
        <span className="text-sm font-bold text-fg">Аудитория ({total})</span>
        {reusable.length > 0 && (
          <button onClick={toMailing} className="btn-soft ml-auto h-8 text-xs" title="Открыть рассылку с этим списком">
            <Send size={13} /> В новую рассылку: {reusable.length}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {GROUPS.map(({ key, label, tone, hint }) => {
          const rows = audience[key]
          const isOpen = open === key
          return (
            <div key={key} className="rounded-xl border border-line/70 bg-base/40">
              <button
                onClick={() => setOpen(isOpen ? null : key)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
                title={hint}
              >
                <ChevronDown size={13} className={cn('text-white/40 transition-transform', isOpen && 'rotate-180')} />
                <Badge tone={tone}>{label}</Badge>
                <span className="font-mono text-sm font-bold text-fg">{rows.length}</span>
                <span className="truncate text-xs text-white/35">{hint}</span>
                {rows.length > 0 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); void copy(key, rows) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void copy(key, rows) } }}
                    className="btn-ghost ml-auto h-7 shrink-0 px-2 text-xs"
                  >
                    {copied === key ? <><Check size={12} /> Скопировано</> : <><Copy size={12} /> Копировать</>}
                  </span>
                )}
              </button>

              {isOpen && rows.length > 0 && (
                <div className="max-h-56 overflow-y-auto border-t border-line/60 px-3 py-1.5">
                  {rows.slice(0, 500).map((r, i) => (
                    <div key={`${r.target}${i}`} className="flex items-center gap-2 border-b border-line/40 py-1 text-sm last:border-0">
                      <span className="font-mono text-white/80">{r.target}</span>
                      {r.reason && <span className="truncate text-xs text-amber-300/80">{r.reason}</span>}
                      {r.accountName && <span className="ml-auto shrink-0 text-xs text-white/35">{r.accountName}</span>}
                      {/* Переписку можно открыть только там, где известно, кто и с кем говорил. */}
                      {r.accountId && (r.peer || r.target.startsWith('@')) && (
                        <button
                          onClick={() => setChat({ kind: 'peer', peer: r.peer || r.target, accountId: r.accountId! })}
                          className="btn-icon h-6 w-6 shrink-0"
                          title="Открыть переписку"
                        >
                          <MessageSquare size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                  {rows.length > 500 && (
                    <p className="py-1.5 text-center text-[11px] text-white/35">
                      Показаны первые 500 — кнопка «Копировать» отдаёт все {rows.length}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <LeadConversationModal source={chat} onClose={() => setChat(null)} />
    </div>
  )
}
