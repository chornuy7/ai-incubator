import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LifeBuoy, Plus, Send, MessageSquare, Clock, Loader2, ArrowLeft } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { useBalance } from '@/features/billing/balanceStore'
import { useSession } from '@/features/auth/session'
import { refreshUnread } from '@/features/support/unreadStore'
import { PageHeader, Card, EmptyState, Select, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { fetchTickets, fetchTicket, createTicket, replyTicket, setTicketStatus, type ApiTicket, type TicketStatus } from '@/api/ticketsApi'
import { TicketChat, shortId } from '@/features/support/TicketChat'
import { cn } from '@/shared/lib/utils'
import { onLive, liveConnected } from '@/shared/lib/liveSocket'

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
  // На /panel/support сторона поддержки — ТОЛЬКО роль «Поддержка» (без админки): для них
  // это рабочее место, все тикеты, ответ как «Поддержка». Админ здесь — обычный клиент
  // (свои тикеты, пишет от своего имени); отвечает как поддержка из Админ-панели → «Тикеты».
  const sessionUser = useSession((s) => s.user)
  /*
   * Сотрудник пишет СВОЕМУ администратору, а не нам (MR-248). Возможность была, а из
   * интерфейса не читалась: страница обещала «связь с командой Murmex», и человек не
   * понимал, что «Новый тикет» уходит его владельцу. Заказчик 31.08: «тикети на
   * поповнення бачу, а як мені написати повідомлення своєму адміну?»
   */
  /*
   * Признак берём из БАЛАНСА, а не из сессии. Сессия зашивается при входе и дальше не
   * меняется: после MR-225 сотрудник со своим кошельком переставал считаться сотрудником
   * до перезахода, и панель показывала ему то одно, то другое (приёмка 31.08 — «обновил
   * страницу и пропала кнопка»). Баланс перечитывается сам, и признак в нём всегда свежий.
   */
  const балансСотрудника = useBalance()
  const яСотрудник = !!(балансСотрудника?.isSub ?? sessionUser?.isSub)
  const isSupportView = !!(sessionUser?.permissions?.resources?.support === 'allow' && !sessionUser?.isAdmin)
  const [tickets, setTickets] = useState<ApiTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  // Кому пишем: своему администратору (по умолчанию) или платформе.
  const [вПоддержку, setВПоддержку] = useState(false)
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState('tech')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [openTicket, setOpenTicket] = useState<ApiTicket | null>(null)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [меняюСтатус, setМеняюСтатус] = useState(false)
  const [params, setParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setTickets(await fetchTickets(isSupportView)) } catch { /* API недоступен — пусто */ } finally { setLoading(false) }
  }, [isSupportView])
  useEffect(() => { void load() }, [load])

  // §8 (MR-45): виджет поддержки открывает «Новый тикет» сразу — по ?new=1.
  useEffect(() => {
    if (params.get('new') === '1') { setNewOpen(true); params.delete('new'); setParams(params, { replace: true }) }
  }, [params, setParams])

  /*
   * Живая переписка: новые сообщения приходят СОБЫТИЕМ.
   *
   * Здесь стоял опрос раз в пять секунд на всё время, пока открыт тикет: двенадцать
   * запросов в минуту у каждого, кто просто держит переписку открытой. Сервер знает о
   * новом сообщении в момент его появления — он и говорит.
   *
   * Опрос остался запасным и редким: канал может быть не поднят или оборваться.
   */
  const openId = openTicket?.id
  useEffect(() => {
    if (!openId) return
    const подтянуть = () => {
      void fetchTicket(openId, isSupportView)
        .then((fresh) => {
          setOpenTicket((cur) => (cur && cur.id === fresh.id ? fresh : cur))
          setTickets((list) => list.map((x) => x.id === fresh.id ? { ...fresh, unread: 0 } : x))
          // Открытие отмечает прочитанным на сервере — счётчик обязан погаснуть сразу,
          // а не через тик опроса: иначе значок висит на глазах у прочитавшего.
          void refreshUnread()
        })
        .catch(() => { /* сеть моргнула — покажем на следующем тике */ })
    }
    const off = onLive('support', подтянуть)
    // Канал сообщает о новых сообщениях; запасной заход нужен, если канала нет. Открытая
    // переписка уже загружена, поэтому «нечего показывать» здесь не бывает.
    const iv = setInterval(() => { if (!liveConnected()) подтянуть() }, 30000)
    return () => { off(); clearInterval(iv) }
  }, [openId, isSupportView])

  // Лента прокручивается к последнему сообщению — как в любом чате.
  const feedRef = useRef<HTMLDivElement>(null)
  const msgCount = openTicket?.messages.length ?? 0
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [msgCount, openId])

  const filtered = filter === 'all' ? tickets : tickets.filter((t) => t.status === filter)

  const submitTicket = async () => {
    if (!subject.trim()) return pushToast({ type: 'error', title: 'Укажите тему обращения' })
    if (!guardNet('создание тикета')) return
    setSaving(true)
    try {
      await createTicket({ subject: subject.trim(), category, body: body.trim(), toSupport: яСотрудник && вПоддержку })
      pushToast({ type: 'success', title: 'Тикет создан', desc: яСотрудник && !вПоддержку ? 'Администратор ответит здесь же.' : 'Поддержка ответит в течение 24 часов.' })
      setNewOpen(false); setSubject(''); setBody(''); setCategory('tech')
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' }) }
    finally { setSaving(false) }
  }

  const openThread = async (t: ApiTicket) => {
    setOpenTicket(t); setReply('')
    // GET тикета отмечает его прочитанным для нашей стороны — сразу гасим счётчик в списке.
    try {
      const fresh = await fetchTicket(t.id, isSupportView)
      setOpenTicket(fresh)
      setTickets((list) => list.map((x) => x.id === fresh.id ? { ...fresh, unread: 0 } : x))
      // И общий счётчик — тот, что в меню и на кнопке поддержки.
      void refreshUnread()
    } catch { /* оставляем то, что есть в списке */ }
  }

  const sendReply = async () => {
    if (!openTicket || !reply.trim()) return
    setReplying(true)
    try {
      const updated = await replyTicket(openTicket.id, reply.trim(), isSupportView)
      setOpenTicket(updated); setReply('')
      setTickets((list) => list.map((x) => x.id === updated.id ? { ...updated, unread: 0 } : x))
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
          title={яСотрудник ? (вПоддержку ? 'Обращение в поддержку' : 'Сообщение администратору') : 'Новый тикет'}
          subtitle={яСотрудник ? (вПоддержку ? 'Вопрос о самой платформе — ответит команда Murmex' : 'Сообщение уйдёт вашему администратору') : 'Опишите проблему — команда ответит в течение суток'}
          icon={<LifeBuoy size={22} />}
        />
        <Card className="max-w-2xl space-y-4 p-5">
          {/*
            Выбор адресата — только у сотрудника: у клиента платформы он один, и лишний
            переключатель там сбивал бы с толку. По умолчанию письмо идёт администратору:
            доступы, аккаунты и токены выдаёт он, и гонять человека через нашу поддержку
            значит вернуть тот самый круг. Но платформа тоже ломается, поэтому дверь к нам
            остаётся открытой.
          */}
          {яСотрудник && (
            <div>
              <label className="label">Кому</label>
              <div className="flex gap-2">
                {([[false, 'Моему администратору'], [true, 'В поддержку Murmex']] as const).map(([знач, подпись]) => (
                  <button
                    key={String(знач)}
                    type="button"
                    onClick={() => setВПоддержку(знач)}
                    className={cn('h-9 rounded-lg border px-3 text-xs font-semibold transition-colors',
                      вПоддержку === знач ? 'border-spark-500/50 bg-spark-500/15 text-spark-200' : 'border-line text-muted hover:text-fg')}
                  >
                    {подпись}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {вПоддержку
                  ? 'Вопрос о самой платформе: что-то не работает, ошибка, сбой.'
                  : 'Доступы, аккаунты, токены и всё, что выдаёт владелец пространства.'}
              </p>
            </div>
          )}
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

  // Переписка — ОТДЕЛЬНАЯ СТРАНИЦА, а не попап: в модалке лента жалась в окошко и
  // закрывалась случайным кликом мимо. Здесь тот же экран, только вместо списка — чат.
  if (openTicket) {
    const meta = STATUS_META[openTicket.status]
    return (
      <div>
        <button onClick={() => setOpenTicket(null)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к обращениям</button>
        <PageHeader
          title={openTicket.subject}
          subtitle={`${openTicket.id}${isSupportView && (openTicket.ownerEmail || openTicket.ownerName) ? ` · клиент ${openTicket.ownerEmail || openTicket.ownerName} · ID ${shortId(openTicket.userId)}` : ''}`}
          icon={<MessageSquare size={22} />}
          badge={meta.label}
        />
        <Card className="flex flex-col overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <span className="text-xs text-muted">Обновлён {fmtTs(openTicket.updatedAt)}</span>
            {/*
              * Приёмка 31.08: обращение висело «в работе» вечно — закрыть его было некому.
              * Кнопка у той же стороны, что отвечает: у платформенной поддержки и у
              * владельца, которому обращение адресовано. Клиенту закрывать нечего —
              * он и так знает, решён его вопрос или нет.
              */}
            {(isSupportView || (!!openTicket.toOwnerId && openTicket.toOwnerId === sessionUser?.id)) && (
              <button
                disabled={меняюСтатус}
                onClick={async () => {
                  setМеняюСтатус(true)
                  try {
                    const след: TicketStatus = openTicket.status === 'closed' ? 'open' : 'closed'
                    setOpenTicket(await setTicketStatus(openTicket.id, след))
                    await load()
                  } catch (e) {
                    pushToast({ type: 'error', title: 'Не удалось изменить статус', desc: e instanceof Error ? e.message : '' })
                  } finally { setМеняюСтатус(false) }
                }}
                className="btn-ghost ml-auto h-8 shrink-0 text-xs"
              >
                {openTicket.status === 'closed' ? 'Открыть заново' : 'Закрыть обращение'}
              </button>
            )}
          </div>
          {/* Лента во всю доступную высоту — чат, а не окошко. */}
          <div ref={feedRef} className="h-[calc(100vh-24rem)] min-h-[280px] overflow-y-auto bg-surface/40 px-4 py-3">
            <TicketChat ticket={openTicket} viewerIsSupport={isSupportView} />
          </div>
          {openTicket.status === 'closed' && (
            <div className="border-t border-line bg-surface px-4 py-2 text-center text-xs text-muted">Тикет закрыт. Новый ответ откроет его снова.</div>
          )}
          <div className="flex gap-2 border-t border-line p-3">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendReply()}
              className="input flex-1"
              placeholder={isSupportView ? 'Ответ поддержки…' : 'Ваше сообщение…'}
              autoFocus
            />
            <button onClick={() => void sendReply()} disabled={replying || !reply.trim()} className="btn-primary h-[42px] px-4 disabled:opacity-50">
              {replying ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={isSupportView ? 'Поддержка · обращения' : 'Поддержка'}
        subtitle={isSupportView
          ? 'Все тикеты пользователей — отвечаете как поддержка'
          : яСотрудник ? 'Переписка с вашим администратором — он выдаёт доступы, аккаунты и токены' : 'Тикеты и связь с командой Murmex'}
        icon={<LifeBuoy size={22} />}
        actions={<>
          <HelpButton topic="support" className="h-10 w-10" />
          {/* Поддержка отвечает, а не создаёт тикеты — «Новый тикет»/«Telegram» ей не нужны. */}
          {!isSupportView && (
            <>
              {/*
                Телеграм-канал — наша поддержка. Сотруднику он не нужен: его вопросы решает
                владелец, а не мы, и лишняя дверь ведёт ровно в тот круг, от которого
                уходили («в поддержке скажут: свяжитесь с администратором»).
              */}
              {!яСотрудник && (
                <button onClick={() => pushToast({ type: 'info', title: 'Открываю Telegram', desc: '@ai_incubator_support (демо).' })} className="btn-ghost h-10"><Send size={16} /> Написать в Telegram</button>
              )}
              <button onClick={() => setNewOpen(true)} className="btn-primary h-10">
                <Plus size={16} /> {яСотрудник ? 'Написать администратору' : 'Новый тикет'}
              </button>
            </>
          )}
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
            desc={яСотрудник ? 'Напишите своему администратору — он ответит здесь же.' : 'Создайте обращение — команда поддержки ответит в течение суток.'}
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
                    {/* Красный значок непрочитанного — новые сообщения от другой стороны. */}
                    {!!t.unread && <span className="grid min-w-[20px] place-items-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{t.unread}</span>}
                    {/* Поддержке важно СРАЗУ видеть, чей это тикет. */}
                    {isSupportView && (t.ownerEmail || t.ownerName) && (
                      <span className="truncate text-[11px] text-iris-300">{t.ownerEmail || t.ownerName}</span>
                    )}
                    {/*
                      MR-257: обращение сотрудника СВОЕМУ владельцу. Мы такие видим (и должны
                      видеть — решение владельца 31.08), но отвечать на них вместо владельца
                      нельзя: токены и аккаунты выдаёт он, а не мы. Метка отделяет «нам» от
                      «не нам» до того, как поддержка начнёт печатать ответ.
                    */}
                    {isSupportView && t.toOwnerId && (
                      <span className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                        сотрудник → владельцу
                      </span>
                    )}
                  </div>
                  <div className={cn('mt-0.5 truncate', t.unread ? 'font-bold text-fg' : 'font-semibold text-fg')}>{t.subject}</div>
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

    </div>
  )
}
