import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, Search, RefreshCw, Send, Check, Users, Radio } from 'lucide-react'
import { activeAccounts, useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Segmented, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import {
  fetchInbox, fetchMessages, sendDialogMessage, markDialogRead,
  type InboxDialog, type DialogMessage, type PeerRef,
} from '@/api/neuroDialogsApi'
import { fetchAccountChannels } from '@/api/accountsApi'
import type { AccountChannel } from '@/shared/types'

const peerOf = (d: InboxDialog): PeerRef => ({ peerId: d.peerId, accessHash: d.accessHash, username: d.username })

export function InboxPage() {
  const pushToast = useApp((s) => s.pushToast)
  const accounts = activeAccounts(useApp((s) => s.data))
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [dialogs, setDialogs] = useState<InboxDialog[]>([])
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [active, setActive] = useState<InboxDialog | null>(null)
  const [messages, setMessages] = useState<DialogMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState(0) // 0 = диалоги, 1 = группы/каналы
  const [groups, setGroups] = useState<(AccountChannel & { accountName: string })[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)

  const toggleAcc = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  const loadInbox = async () => {
    if (!sel.size) { setDialogs([]); return }
    setLoadingInbox(true)
    try {
      const r = await fetchInbox([...sel], 120)
      setDialogs(r.dialogs.filter((d) => !d.error))
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить диалоги', desc: err instanceof Error ? err.message : '' })
    } finally { setLoadingInbox(false) }
  }
  useEffect(() => { void loadInbox() }, [sel])

  const loadGroups = async () => {
    if (!sel.size) { setGroups([]); return }
    setLoadingGroups(true)
    try {
      const per = await Promise.all([...sel].map(async (id) => {
        const acc = accounts.find((a) => a.id === id)
        const name = acc?.name || acc?.phone || id.slice(-6)
        try {
          const r = await fetchAccountChannels(id)
          return (r.channels || []).map((c) => ({ ...c, accountName: name }))
        } catch { return [] }
      }))
      setGroups(per.flat())
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить группы', desc: err instanceof Error ? err.message : '' })
    } finally { setLoadingGroups(false) }
  }
  useEffect(() => { if (tab === 1) void loadGroups() }, [sel, tab])

  const openDialog = async (d: InboxDialog) => {
    setActive(d); setMessages([]); setLoadingMsgs(true)
    try {
      const r = await fetchMessages(d.accountId, peerOf(d), 60)
      setMessages([...r.messages].sort((a, b) => a.date - b.date))
      void markDialogRead(d.accountId, peerOf(d)).then(() => {
        setDialogs((prev) => prev.map((x) => x.key === d.key ? { ...x, unread: 0 } : x))
      }).catch(() => {})
      setTimeout(() => endRef.current?.scrollIntoView(), 50)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось открыть диалог', desc: err instanceof Error ? err.message : '' })
    } finally { setLoadingMsgs(false) }
  }

  const send = async () => {
    if (!active || !draft.trim()) return
    setSending(true)
    try {
      const r = await sendDialogMessage(active.accountId, peerOf(active), draft.trim())
      setMessages((m) => [...m, r.message])
      setDraft('')
      setTimeout(() => endRef.current?.scrollIntoView(), 50)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не отправлено', desc: err instanceof Error ? err.message : '' })
    } finally { setSending(false) }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? dialogs.filter((d) => d.name.toLowerCase().includes(q) || d.username.toLowerCase().includes(q)) : dialogs
  }, [dialogs, search])
  const totalUnread = useMemo(() => dialogs.reduce((s, d) => s + (d.unread || 0), 0), [dialogs])

  return (
    <div>
      <PageHeader
        title="Обзор аккаунта (Telegram)"
        subtitle="Что делает аккаунт: в каких группах и каналах состоит, все диалоги и переписка — как будто открыли его Telegram."
        icon={<MessagesSquare size={22} />}
        badge={totalUnread ? `${totalUnread} непроч.` : undefined}
        actions={<div className="flex items-center gap-2"><HelpButton topic="inbox" className="h-10 w-10" /><button onClick={() => void (tab === 0 ? loadInbox() : loadGroups())} className="btn-ghost h-10"><RefreshCw size={16} className={(loadingInbox || loadingGroups) ? 'animate-spin' : ''} /> Обновить</button></div>}
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {accounts.length === 0 && <span className="text-sm text-white/40">Нет аккаунтов в панели.</span>}
        {accounts.map((a) => {
          const on = sel.has(a.id)
          return (
            <button key={a.id} onClick={() => toggleAcc(a.id)} className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm ${on ? 'bg-spark-500 text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>
              {on && <Check size={13} />}{a.name || a.phone || a.id.slice(-6)}
            </button>
          )
        })}
      </div>

      {sel.size === 0 ? (
        <EmptyState icon={<MessagesSquare size={26} />} title="Выберите аккаунт(ы)" desc="Отметьте аккаунты выше — покажем в каких группах состоит и все диалоги, как в Telegram." />
      ) : (
        <>
        <div className="mb-3">
          <Segmented
            options={[`Диалоги${totalUnread ? ` · ${totalUnread}` : ''}`, `Группы и каналы${groups.length ? ` · ${groups.length}` : ''}`]}
            value={tab}
            onChange={setTab}
            size="sm"
          />
        </div>

        {tab === 1 ? (
          <Card className="p-0">
            {loadingGroups ? (
              <div className="p-6 text-center text-sm text-white/40">Загрузка групп и каналов…</div>
            ) : groups.length === 0 ? (
              <div className="p-6 text-center text-sm text-white/40">Аккаунт не состоит в группах/каналах (или список недоступен).</div>
            ) : (
              <div className="flex flex-col">
                {groups.map((g, i) => (
                  <div key={`${g.accountName}:${g.id}:${i}`} className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5">
                    {g.kind === 'channel' ? <Radio size={16} className="text-iris-300" /> : <Users size={16} className="text-spark-300" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{g.title}</div>
                      <div className="flex flex-wrap gap-x-3 text-xs text-white/40">
                        {g.username && <span>@{g.username}</span>}
                        {g.members != null && <span>{g.members} участников</span>}
                        <span>акк: {g.accountName}</span>
                      </div>
                    </div>
                    <Badge tone={g.kind === 'channel' ? 'iris' : 'spark'}>{g.kind === 'channel' ? 'канал' : 'группа'}</Badge>
                    {g.unread > 0 && <span className="rounded-full bg-spark-500 px-1.5 text-xs font-bold text-black">{g.unread}</span>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
        <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
          {/* Список диалогов */}
          <Card className="flex max-h-[70vh] flex-col overflow-hidden p-0">
            <div className="border-b border-white/10 p-2">
              <div className="flex items-center gap-2 rounded-lg bg-white/5 px-2">
                <Search size={14} className="text-white/40" />
                <input className="h-8 flex-1 bg-transparent text-sm outline-none" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск диалогов…" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingInbox && !dialogs.length ? (
                <p className="p-6 text-center text-sm text-white/40">Загрузка диалогов…</p>
              ) : filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-white/40">Диалогов нет</p>
              ) : filtered.map((d) => (
                <button key={d.key} onClick={() => void openDialog(d)} className={`flex w-full items-start gap-2 border-b border-white/5 px-3 py-2 text-left hover:bg-white/5 ${active?.key === d.key ? 'bg-white/10' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">{d.name}</span>
                      {d.unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-spark-500 px-1.5 text-xs font-bold text-black">{d.unread}</span>}
                    </div>
                    <div className="truncate text-xs text-white/40">{d.last || '—'}</div>
                    <div className="text-[10px] text-white/25">акк: {d.accountName}</div>
                  </div>
                </button>
              ))}
            </div>
          </Card>

          {/* Переписка */}
          <Card className="flex max-h-[70vh] flex-col overflow-hidden p-0">
            {!active ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-white/40">
                <MessagesSquare size={28} />
                <div className="font-medium text-white/70">Выберите диалог</div>
                <div className="text-sm">Слева — все диалоги и группы выбранных аккаунтов.</div>
              </div>
            ) : (
              <>
                <div className="border-b border-white/10 px-4 py-2.5">
                  <div className="font-semibold text-white">{active.name}</div>
                  <div className="text-xs text-white/40">{active.username ? `@${active.username} · ` : ''}через {active.accountName}</div>
                </div>
                <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                  {loadingMsgs ? (
                    <p className="py-6 text-center text-sm text-white/40">Загрузка…</p>
                  ) : messages.length === 0 ? (
                    <p className="py-6 text-center text-sm text-white/40">Сообщений нет</p>
                  ) : messages.map((m) => (
                    <div key={m.id} className={`flex ${m.out ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${m.out ? 'bg-spark-500/20 text-white' : 'bg-white/10 text-white/90'}`}>
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                        <div className="mt-0.5 text-right text-[10px] text-white/30">{m.time}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={endRef} />
                </div>
                <div className="flex items-center gap-2 border-t border-white/10 p-2">
                  <input className="input h-10 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Написать сообщение…" onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()} />
                  <button onClick={() => void send()} disabled={sending || !draft.trim()} className="btn-primary h-10"><Send size={15} /></button>
                </div>
              </>
            )}
          </Card>
        </div>
        )}
        </>
      )}
    </div>
  )
}
