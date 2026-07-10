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
  HelpButton,
  LaunchPanel,
  PromptCards,
  loadPromptBodies,
  ProtectionBlock,
  AiGenerationNotice,
  TimingSection,
  type DelaysShape,
} from '@/features/modules/shared'
import type { ModuleTaskSettings } from '@/api/modulesApi'

const cfg = MODULES['neuro-dialogs']!

const GOAL_KEY = 'neuro-dialogs:goal'
const SCOPE_KEY = 'neuro-dialogs:replyAll'

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
  const { task, running, starting, start, stop, savePreset, deletePreset, presets } = useModuleTask('neuro-dialogs')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewTab, setViewTab] = useState(0)
  const [aiOpen, setAiOpen] = useState(true)
  const [aiEnabled, setAiEnabled] = useState(true)
  const [replyAll, setReplyAll] = useState(() => localStorage.getItem(SCOPE_KEY) === '1')
  const [dialogGoal, setDialogGoal] = useState(() => localStorage.getItem(GOAL_KEY) ?? '')
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() =>
    loadPromptBodies('neuro-dialogs', cfg.messagePrompts ?? []),
  )
  // Лимиты для ЛС. Важно: общий лимит и лимит на аккаунт — это ДИАПАЗОН [min, max],
  // из которого воркер берёт случайное число (антидетект). Для авто-ответчика min по умолчанию
  // равен max, иначе цель могла бы выпасть в 0–1 и задача завершалась бы после первого ответа.
  // Лимит на аккаунт держим равным общему, чтобы один аккаунт не «упирался» раньше времени
  // и монитор не висел в статусе «работает», ничего не отвечая.
  const [maxActions, setMaxActions] = useState(50)
  const [minActions, setMinActions] = useState(50)
  const [maxPerAcc, setMaxPerAcc] = useState(50)
  const [minPerAcc, setMinPerAcc] = useState(50)
  const [delayPreset, setDelayPreset] = useState(1)
  const [delays, setDelays] = useState<DelaysShape>({
    comment: [30, 120],
    action: [20, 90],
    join: [84, 156],
    floodWait: 120,
    floodQuarantine: 3,
  })

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

  useEffect(() => { localStorage.setItem(GOAL_KEY, dialogGoal) }, [dialogGoal])
  useEffect(() => { localStorage.setItem(SCOPE_KEY, replyAll ? '1' : '0') }, [replyAll])

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    maxActions,
    minActions,
    maxPerAccount: maxPerAcc,
    minPerAccount: minPerAcc,
    delayPreset,
    delays,
    probability: aiEnabled ? 100 : 0,
    replyScope: replyAll ? 'all' : 'unread',
    dialogGoal: dialogGoal.trim(),
  }), [accountIds, aiProtect, protLevel, activePrompt, promptBodies, maxActions, minActions, maxPerAcc, minPerAcc, delayPreset, delays, aiEnabled, replyAll, dialogGoal])

  const applyPreset = useCallback((s: ModuleTaskSettings) => {
    if (s.aiProtection !== undefined) setAiProtect(s.aiProtection)
    if (s.protectionLevel !== undefined) setProtLevel(s.protectionLevel)
    if (s.promptIndex !== undefined) setActivePrompt(s.promptIndex)
    if (Array.isArray(s.promptOverrides)) setPromptBodies(s.promptOverrides)
    if (s.maxActions !== undefined) setMaxActions(s.maxActions)
    if (s.minActions !== undefined) setMinActions(s.minActions)
    if (s.maxPerAccount !== undefined) setMaxPerAcc(s.maxPerAccount)
    if (s.minPerAccount !== undefined) setMinPerAcc(s.minPerAccount)
    if (s.delayPreset !== undefined) setDelayPreset(s.delayPreset)
    if (s.delays) setDelays((d) => ({ ...d, ...s.delays }))
    if (s.probability !== undefined) setAiEnabled(s.probability > 0)
    if (s.replyScope) setReplyAll(s.replyScope === 'all')
    if (typeof s.dialogGoal === 'string') setDialogGoal(s.dialogGoal)
    pushToast({ type: 'success', title: 'Пресет применён' })
  }, [pushToast])

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
        <div className="flex items-center gap-3 px-4 py-3.5">
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-400">
              <Sparkles size={18} />
            </span>
            <span className="font-display text-base font-bold text-fg">ИИ авто-ответы</span>
            <Badge tone={aiEnabled ? 'spark' : 'muted'}>{aiEnabled ? 'включено' : 'выключено'}</Badge>
            <ChevronDown size={16} className={cn('ml-auto text-muted transition-transform', !aiOpen && '-rotate-90')} />
          </button>
          <HelpButton topic="НейроДиалоги" />
        </div>
        {aiOpen && (
          <div className="space-y-4 border-t border-line p-4">
            <Switch
              checked={aiEnabled}
              onChange={setAiEnabled}
              label="Отвечать на входящие автоматически"
              desc="ИИ генерирует ответы на новые ЛС при запущенном модуле"
            />
            <Switch
              checked={replyAll}
              onChange={setReplyAll}
              label="Отвечать всем, кто писал"
              desc="Не только новым: ИИ ответит в каждом ЛС, где последнее сообщение от собеседника — даже если оно уже прочитано"
            />

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-fg">Инструкция для ИИ · цель диалога</span>
                <span className="text-[11px] text-faint">{dialogGoal.trim().length} симв.</span>
              </div>
              <textarea
                value={dialogGoal}
                onChange={(e) => setDialogGoal(e.target.value)}
                rows={4}
                className="input w-full resize-none text-sm"
                placeholder={
                  'Ты — менеджер студии Auto Mapping.\n' +
                  'Цель: выяснить задачу клиента и пригласить на бесплатный созвон.\n' +
                  'Отвечай коротко, на «ты», задавай один уточняющий вопрос за раз.'
                }
              />
              <p className="text-xs leading-relaxed text-muted">
                Добавляется к выбранному промпту и применяется к каждому авто-ответу: кем быть, как общаться и к чему вести диалог.
              </p>
            </div>

            <p className="rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs leading-relaxed text-muted">
              Авто-режим (кнопка «Запустить») отвечает {replyAll
                ? <b className="text-fg">всем, кто написал последним</b>
                : <b className="text-fg">только на непрочитанные входящие ЛС</b>} выбранных аккаунтов — сам первым никому не пишет.
              Без ключа OpenAI ответы будут шаблонными и цель диалога учтена не будет. Вкладка <b className="text-fg">«Переписки»</b> ниже — ручной инбокс: читайте и отвечайте руками.
            </p>
            {replyAll && (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
                Разбор накопившихся ЛС — самый рискованный режим: пачка ответов подряд с одного номера ловит PEER_FLOOD и репорты.
                Аккаунт отвечает не более чем в {[2, 4, 6][protLevel]} диалогах за заход и уходит в конец очереди, но лимиты и задержки
                в секции <b className="text-fg">«Тайминги и задержки»</b> всё равно стоит проверить перед первым запуском.
              </p>
            )}
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

      <TimingSection
        totalLabel="Ответов за запуск"
        total={{ min: minActions, max: maxActions, onMin: setMinActions, onMax: setMaxActions }}
        perAccount={{ min: minPerAcc, max: maxPerAcc, onMin: setMinPerAcc, onMax: setMaxPerAcc }}
        delays={delays}
        onDelays={(updater) => setDelays(updater)}
        showComment={false}
        showAction
        showJoin={false}
        labels={{ action: 'Задержка между ответами' }}
        delayPresets={['Мин', 'Рекомендуемые', 'Макс']}
        delayPreset={delayPreset}
        onDelayPreset={setDelayPreset}
      />

      <p className="rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs leading-relaxed text-muted">
        «Ответов за запуск» и «На аккаунт» — это диапазон: воркер берёт случайное число между «от» и «до» (для маскировки под живого человека).
        Если поставить «от» = 0, задача может случайно завершиться после первого же ответа. По умолчанию «от» = «до», то есть лимит фиксированный.
      </p>

      <SectionCard icon={<Play size={18} />} title={running ? 'Мониторинг' : 'Запуск'} badge={running ? 'LIVE' : undefined}>
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          onStart={() => { setViewTab(1); void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`) }}
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
          presets={presets}
          onApplyPreset={applyPreset}
          onDeletePreset={deletePreset}
        />
        <div className="mt-4">
          <Segmented options={['Переписки', logs.length ? `Логи · ${logs.length}` : 'Логи']} value={viewTab} onChange={setViewTab} size="sm" />
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
              <HelpButton topic="НейроДиалоги" className="h-9 w-9" />
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
