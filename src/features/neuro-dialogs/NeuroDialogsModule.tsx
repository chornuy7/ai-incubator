import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Sparkles, Search, Send, MessagesSquare, Mail, Users,
  RefreshCw, Loader2, ChevronDown, ExternalLink,
} from 'lucide-react'
import { MODULES } from '@/shared/config/modules'
import { useApp } from '@/mocks/store'
import { Avatar, Badge, Segmented, Switch } from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { cn } from '@/shared/lib/utils'
import {
  fetchInbox,
  fetchMessages,
  sendDialogMessage,
  markDialogRead,
  type InboxDialog,
  type DialogMessage,
} from '@/api/neuroDialogsApi'
import { useModuleTask } from '@/features/modules/shared/useModuleTask'
import {
  SectionCard,
  LaunchPanel,
  PromptCards,
  loadPromptBodies,
  ProtectionBlock,
  AiGenerationNotice,
} from '@/features/modules/shared'
import type { ModuleTaskSettings } from '@/api/modulesApi'

const cfg = MODULES['neuro-dialogs']!

function peerRef(d: Pick<InboxDialog, 'peerId' | 'accessHash' | 'username'>) {
  return { peerId: d.peerId, accessHash: d.accessHash, username: d.username || undefined }
}

function avatarColor(name: string) {
  const palette = ['#7145ff', '#06b6d4', '#0ec464', '#f59e0b', '#ec4899', '#229ED9']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i) * 17) % palette.length
  return palette[h]
}

const DialogRow = memo(function DialogRow({
  d,
  active,
  onClick,
}: {
  d: InboxDialog
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 72px' }}
      className={cn(
        'flex w-full items-center gap-3 border-b border-line/50 p-3 text-left transition-colors hover:bg-elevated',
        active && 'bg-iris-500/10',
        d.error && 'opacity-60',
      )}
    >
      <Avatar name={d.name} color={avatarColor(d.name)} size={42} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-bold text-fg">{d.name}</span>
          <span className="shrink-0 text-[11px] text-faint">{d.time}</span>
        </div>
        <div className="truncate text-xs text-muted">{d.last || '—'}</div>
        <div className="truncate text-[11px] text-iris-300/80">
          {d.accountName}{d.username ? ` · @${d.username}` : ''}
        </div>
      </div>
      {d.unread > 0 && (
        <span className="grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">
          {d.unread > 99 ? '99+' : d.unread}
        </span>
      )}
    </button>
  )
})

const MessageBubble = memo(function MessageBubble({ m }: { m: DialogMessage }) {
  return (
    <div className={cn('flex', m.out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          m.out ? 'bg-iris-gradient text-white' : 'border border-line bg-surface text-fg',
        )}
      >
        <span className="whitespace-pre-wrap break-words">{m.text}</span>
        <span className={cn('mt-1 block text-[10px]', m.out ? 'text-white/70' : 'text-faint')}>{m.time}</span>
      </div>
    </div>
  )
})

export function NeuroDialogsModule() {
  const pushToast = useApp((s) => s.pushToast)
  const { task, running, starting, start, stop, savePreset } = useModuleTask('neuro-dialogs')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewTab, setViewTab] = useState(0)
  const [aiOpen, setAiOpen] = useState(true)
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() =>
    loadPromptBodies('neuro-dialogs', cfg.messagePrompts ?? []),
  )
  const maxActions = 50
  const maxPerAcc = 10

  const [search, setSearch] = useState('')
  const [dialogs, setDialogs] = useState<InboxDialog[]>([])
  const [inboxLoading, setInboxLoading] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [messages, setMessages] = useState<DialogMessage[]>([])
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  const msgCache = useRef<Map<string, DialogMessage[]>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const accountIds = useMemo(() => [...selected], [selected])

  const activeDialog = useMemo(
    () => dialogs.find((d) => d.key === activeKey) ?? null,
    [dialogs, activeKey],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return dialogs
    return dialogs.filter(
      (d) =>
        `${d.name} ${d.last} ${d.username} ${d.accountName}`.toLowerCase().includes(q),
    )
  }, [dialogs, search])

  const totalUnread = useMemo(() => dialogs.reduce((s, d) => s + (d.unread || 0), 0), [dialogs])

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    maxActions,
    maxPerAccount: maxPerAcc,
    probability: aiEnabled ? 100 : 0,
  }), [accountIds, aiProtect, protLevel, activePrompt, promptBodies, maxActions, maxPerAcc, aiEnabled])

  const loadInbox = useCallback(async (silent = false) => {
    if (!accountIds.length) {
      setDialogs([])
      msgCache.current.clear()
      return
    }
    if (!silent) setInboxLoading(true)
    try {
      const res = await fetchInbox(accountIds, 120)
      setDialogs(res.dialogs.filter((d) => !d.error))
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Не удалось загрузить диалоги',
        desc: err instanceof Error ? err.message : 'Ошибка',
      })
    } finally {
      if (!silent) setInboxLoading(false)
    }
  }, [accountIds, pushToast])

  const openDialog = useCallback(async (d: InboxDialog) => {
    if (d.error || !d.peerId) return
    setActiveKey(d.key)
    setDialogs((list) => list.map((x) => (x.key === d.key ? { ...x, unread: 0 } : x)))

    const cached = msgCache.current.get(d.key)
    if (cached) {
      setMessages(cached)
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))
      void markDialogRead(d.accountId, peerRef(d)).catch(() => {})
      return
    }

    setMsgsLoading(true)
    try {
      const res = await fetchMessages(d.accountId, peerRef(d), 80)
      msgCache.current.set(d.key, res.messages)
      setMessages(res.messages)
      void markDialogRead(d.accountId, peerRef(d)).catch(() => {})
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Ошибка загрузки переписки',
        desc: err instanceof Error ? err.message : 'Ошибка',
      })
      setMessages([])
    } finally {
      setMsgsLoading(false)
    }
  }, [pushToast])

  const send = useCallback(async () => {
    if (!reply.trim() || !activeDialog?.peerId) return
    const text = reply.trim()
    setSending(true)
    setReply('')
    try {
      const res = await sendDialogMessage(activeDialog.accountId, peerRef(activeDialog), text)
      setMessages((prev) => {
        const next = [...prev, res.message]
        msgCache.current.set(activeDialog.key, next)
        return next
      })
      setDialogs((list) =>
        list.map((d) => (d.key === activeDialog.key ? { ...d, last: text, time: 'сейчас' } : d)),
      )
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))
    } catch (err) {
      setReply(text)
      pushToast({
        type: 'error',
        title: 'Не отправлено',
        desc: err instanceof Error ? err.message : 'Ошибка',
      })
    } finally {
      setSending(false)
    }
  }, [reply, activeDialog, pushToast])

  useEffect(() => {
    void loadInbox()
  }, [loadInbox])

  useEffect(() => {
    if (!accountIds.length || viewTab !== 0) return
    const t = setInterval(() => void loadInbox(true), 25_000)
    return () => clearInterval(t)
  }, [accountIds.length, viewTab, loadInbox])

  const canStart = accountIds.length > 0
  const logs = task?.logs ?? []

  return (
    <div className="space-y-4">
      <AccountPicker
        selected={selected}
        onChange={setSelected}
        actions={cfg.accountActions}
        withFilters={!!cfg.accountFilters}
        selectedTitle={cfg.selectedTitle ?? 'Выбрано'}
      />

      <div className="card p-0">
        <button
          type="button"
          onClick={() => setAiOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
        >
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/12 text-iris-400">
            <Sparkles size={18} />
          </span>
          <span className="font-display text-base font-bold text-fg">ИИ авто-ответы</span>
          <Badge tone={aiEnabled ? 'spark' : 'muted'}>{aiEnabled ? 'включено' : 'выключено'}</Badge>
          <ChevronDown size={16} className={cn('ml-auto text-muted transition-transform', !aiOpen && '-rotate-90')} />
        </button>
        {aiOpen && (
          <div className="space-y-4 border-t border-line p-4">
            <Switch
              checked={aiEnabled}
              onChange={setAiEnabled}
              label="Отвечать на входящие автоматически"
              desc="ИИ генерирует ответы на новые ЛС при запущенном модуле"
            />
            <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />
            {cfg.messagePrompts && (
              <div className="space-y-3">
                <AiGenerationNotice />
                <PromptCards
                moduleKey="neuro-dialogs"
                labels={cfg.messagePrompts}
                activeIndex={activePrompt}
                onActiveChange={setActivePrompt}
                  onBodiesChange={setPromptBodies}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <SectionCard icon={<Play size={18} />} title={running ? 'Мониторинг' : 'Запуск'} badge={running ? 'LIVE' : undefined}>
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          onStart={() => void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`)}
          onStop={stop}
          onSave={() => {
            const name = window.prompt('Название пресета')
            if (name?.trim()) void savePreset(name.trim(), buildSettings())
          }}
          primaryLabel={cfg.primaryAction ?? 'Запустить'}
          stats={[
            { icon: <MessagesSquare size={18} />, color: '#06b6d4', label: 'Диалогов', value: String(dialogs.length) },
            { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунтов', value: String(selected.size), warn: !selected.size },
            { icon: <Mail size={18} />, color: '#f59e0b', label: 'Непрочит.', value: String(totalUnread) },
            { icon: <Sparkles size={18} />, color: '#0ec464', label: 'ИИ', value: aiEnabled ? 'ON' : 'OFF' },
          ]}
          task={task}
          warn={!canStart ? 'Выберите хотя бы один аккаунт' : undefined}
        />
        <div className="mt-4">
          <Segmented options={['Переписки', 'Логи']} value={viewTab} onChange={setViewTab} size="sm" />
        </div>
      </SectionCard>

      {viewTab === 1 ? (
        <LogsPanel logs={logs} emptyText={cfg.logEmpty ?? 'Логов пока нет'} title="Логи выполнения" live={running} />
      ) : (
        <div className="card grid min-h-[520px] gap-0 overflow-hidden p-0 lg:grid-cols-[minmax(280px,340px)_1fr]">
          <div className="flex flex-col border-b border-line lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-2 border-b border-line p-3">
              <div className="relative min-w-0 flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input h-9 w-full pl-9 text-sm"
                  placeholder="Поиск диалогов…"
                />
              </div>
              <button
                type="button"
                onClick={() => void loadInbox()}
                disabled={inboxLoading || !accountIds.length}
                className="btn-icon h-9 w-9 shrink-0"
                title="Обновить"
              >
                {inboxLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={15} />}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-280px)]">
              {!accountIds.length ? (
                <p className="p-6 text-center text-sm text-muted">Выберите аккаунты — загрузим все ЛС</p>
              ) : inboxLoading && !dialogs.length ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
                  <Loader2 size={18} className="animate-spin text-iris-400" /> Загрузка диалогов…
                </div>
              ) : filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted">Диалоги не найдены</p>
              ) : (
                filtered.map((d) => (
                  <DialogRow
                    key={d.key}
                    d={d}
                    active={activeKey === d.key}
                    onClick={() => void openDialog(d)}
                  />
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-[420px] flex-col">
            {activeDialog ? (
              <>
                <div className="flex items-center gap-3 border-b border-line p-3">
                  <Avatar name={activeDialog.name} color={avatarColor(activeDialog.name)} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-fg">{activeDialog.name}</div>
                    <div className="truncate text-xs text-muted">
                      через {activeDialog.accountName}
                      {activeDialog.username ? ` · @${activeDialog.username}` : ''}
                    </div>
                  </div>
                  {activeDialog.username && (
                    <a
                      href={`https://t.me/${activeDialog.username}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-icon h-9 w-9 shrink-0"
                      title="Открыть в Telegram"
                    >
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>

                <div
                  ref={scrollRef}
                  className="flex-1 space-y-2 overflow-y-auto overscroll-contain bg-[rgb(var(--bg))] p-4"
                >
                  {msgsLoading ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                      <Loader2 size={18} className="animate-spin" /> Загрузка сообщений…
                    </div>
                  ) : (
                    messages.map((m) => <MessageBubble key={m.id} m={m} />)
                  )}
                </div>

                <div className="flex items-center gap-2 border-t border-line p-3">
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void send())}
                    className="input min-w-0 flex-1"
                    placeholder="Написать сообщение…"
                    disabled={sending}
                  />
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={sending || !reply.trim()}
                    className="btn-iris h-[42px] shrink-0 px-4"
                  >
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="grid h-20 w-20 place-items-center rounded-full border border-line bg-elevated text-iris-400">
                  <MessagesSquare size={34} />
                </div>
                <div>
                  <div className="font-display text-base font-bold text-fg">Выберите диалог</div>
                  <div className="mt-1 max-w-xs text-sm text-muted">
                    {accountIds.length
                      ? 'Слева все ЛС выбранных аккаунтов. Клик — мгновенное открытие переписки.'
                      : 'Сначала выберите аккаунты в панели выше'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
