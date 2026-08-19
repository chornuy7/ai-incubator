import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import {
  Menu, Zap, Sun, Moon, Radar, ChevronDown, UserCog, LogOut, Wallet, Check, AlertTriangle, Package, Bell, X, Clock,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { useApp, activeAccounts, isBrokenAccount } from '@/mocks/store'
import { fetchAllTasks, type ModuleTask } from '@/api/modulesApi'
import { fetchTickets, type ApiTicket } from '@/api/ticketsApi'
import { fetchAwaitingReplies, type AwaitingReply } from '@/api/neuroDialogsApi'
import { fetchBalance, fetchPricing, buyTokens, fetchWalletHistory, type Balance, type Pricing, type WalletEntry } from '@/api/balanceApi'
import { useSession } from '@/features/auth/session'
import { usePlan } from '@/features/billing/plan'
import { CRITICAL } from '@/features/billing/LowBalanceBar'

/**
 * Сколько токенов считается «запасом» — при таком балансе чип зелёный (MR-166, 14.08).
 * Порог назвал заказчик: «больше 500 токенов пусть оно становится зелёным».
 */
const HEALTHY_COINS = 500
import { useUi } from '@/shared/lib/uiStore'
import { coins as fmtCoins } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'
import { Dropdown, MenuItem, Modal, Avatar } from '@/shared/ui'
import { LANGUAGES, moduleTitle } from '@/shared/config/modules'

/**
 * Запасные пакеты — на случай, если прайс с сервера не приехал. Настоящие цены
 * живут в server/pricing.js: курс монеты определяет реальную выручку с действия,
 * и копия в вебе неизбежно разъедется с прайсом и счётом.
 */
const FALLBACK_PACKS = [
  { coins: 50, price: 4.99 },
  { coins: 200, price: 17.99, best: true },
  { coins: 500, price: 39.99 },
]

// Уведомления (12.08): всегда показываем ДАТУ и время («14 авг, 13:46»), чтобы было
// видно, за какой день событие (раньше был только час — вчерашнее путалось с сегодняшним).
function fmtNotifTs(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function AppHeader() {
  const nav = useNavigate()
  const data = useApp((s) => s.data)
  // B2 (§5.1): план и монеты — с сервера, а не константа из моков. Раньше в шапке
  // всегда висели «Базовая» и 80.00 независимо от того, что происходило в системе.
  // Обновляем периодически: списания за действия (C2) идут в фоне, и цифра должна
  // меняться без перезагрузки страницы.
  const [balance, setBalance] = useState<Balance | null>(null)
  useEffect(() => {
    const load = () => { void fetchBalance().then(setBalance).catch(() => {}) }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  // Прайс — с сервера: копия в вебе рано или поздно разошлась бы с тем, что списывается.
  const [pricing, setPricing] = useState<Pricing | null>(null)
  useEffect(() => { void fetchPricing().then(setPricing).catch(() => {}) }, [])
  // §6.3 (NOTIFY-001): колокольчик — сколько аккаунтов «отвалилось» (мёртвый прокси / нерабочий статус).
  const [notifOpen, setNotifOpen] = useState(false)
  // Закрытие колокольчика кликом ВНЕ него: прозрачный backdrop не срабатывал, т.к.
  // сайдбар/шапка перекрывали его по бокам. Слушаем документ по ref — надёжно.
  const notifRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!notifOpen) return
    const onDown = (e: MouseEvent) => { if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [notifOpen])
  const broken = activeAccounts(data).filter(isBrokenAccount)
  // §6.3 (NOTIFY-001, доработка): уведомление можно закрыть вручную. Отклонённые id храним в
  // localStorage; если аккаунт восстановится и снова отвалится — уведомит заново.
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('notif-dismissed') || '[]')) } catch { return new Set() }
  })
  useEffect(() => { localStorage.setItem('notif-dismissed', JSON.stringify([...dismissed])) }, [dismissed])
  const brokenKey = broken.map((a) => a.id).sort().join(',')
  useEffect(() => {
    // восстановившиеся аккаунты убираем из «отклонённых» — новое падение снова уведомит.
    setDismissed((prev) => {
      const bset = new Set(broken.map((a) => a.id))
      // MR-134: task:/wallet:/ticket:/awaiting-дисмиссы не трогаем — они не про аккаунты.
      const next = new Set([...prev].filter((id) => id.startsWith('task:') || id.startsWith('wallet:') || id.startsWith('ticket:') || id === 'awaiting' || bset.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokenKey])
  const shown = broken.filter((a) => !dismissed.has(a.id))
  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id))
  // «Скрыть все» — прячем ровно то, что сейчас показано (задачи, аккаунты, пополнения).
  const dismissAll = () => setDismissed((prev) => { const n = new Set(prev); notifItems.forEach((i) => n.add(i.key)); return n })

  // MR-134: уведомления по СТАТУСУ ЗАДАЧИ — ошибка/пауза требуют внимания оператора.
  // Тянем агрегат задач (лёгкий поллинг), выводим рядом с «отвалившимися аккаунтами».
  const [tasks, setTasks] = useState<ModuleTask[]>([])
  const [wallet, setWallet] = useState<WalletEntry[]>([]) // MR-134: пополнения баланса (зелёные)
  const [tickets, setTickets] = useState<ApiTicket[]>([]) // MR-134: обращения в поддержку
  const [awaiting, setAwaiting] = useState<{ count: number; items: AwaitingReply[] }>({ count: 0, items: [] }) // MR-134: пропущенные ЛС
  useEffect(() => {
    let alive = true
    const pull = () => {
      void fetchAllTasks().then((t) => { if (alive) setTasks(t) }).catch(() => {})
      void fetchWalletHistory(20).then((w) => { if (alive) setWallet(w) }).catch(() => {})
      void fetchTickets().then((t) => { if (alive) setTickets(t) }).catch(() => {})
      void fetchAwaitingReplies().then((a) => { if (alive) setAwaiting(a) }).catch(() => {})
    }
    pull()
    // Колокольчик — фон, а не рабочий инструмент: раз в минуту достаточно, и на скрытой
    // вкладке молчим. Раньше это были 4 запроса каждые 30с на ЛЮБОЙ странице.
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      pull()
    }, 60000)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  // MR-134: колокольчик по статусу задачи — ошибка, пауза И завершение (по ТЗ 10.08).
  // «Завершена» показываем только НЕДАВНО законченные (updatedAt за 12ч), иначе старые
  // done копились бы вечно. Задача может отключить уведомления галочкой в блоке запуска.
  const TASK_DONE_WINDOW = 12 * 60 * 60 * 1000
  const isRecentTask = (t: ModuleTask) => !!t.updatedAt && (Date.now() - t.updatedAt) < TASK_DONE_WINDOW
  // MR-134: подтягиваем ВСЕ информативные состояния задачи из данных списка /tasks:
  // ошибка/в очереди/пауза/идёт-с-ошибками — всегда; завершена/остановлена — недавние (12ч).
  const taskAlertsAll = tasks.filter((t) =>
    t.settings?.notifyOnStatus !== false && (
      t.status === 'error' || t.status === 'paused' || t.status === 'queued' ||
      (t.status === 'running' && ((t.errors ?? 0) > 0 || (t.floodWaits ?? 0) > 0)) ||
      ((t.status === 'done' || t.status === 'stopped') && isRecentTask(t))
    ),
  )
  const taskAlerts = taskAlertsAll.filter((t) => !dismissed.has(`task:${t.id}`))

  // MR-134 (модель заказчика 11.08): уведомления сгруппированы по ЦВЕТУ, а не по типу.
  //  🔴 красный — ошибка (аккаунт в бане, прокси слетел, задача с ошибкой);
  //  🟡 жёлтый — ожидание (задача на паузе/в процессе, без прокси, временное ограничение);
  //  🟢 зелёный — хороший результат (задача выполнена).
  // MR-134 (созвон 12.08): у каждого уведомления есть время (ts) — список сортируется ПО ВРЕМЕНИ
  // (свежие сверху), а не группами по цвету; время показывается в строке. Цвет по-прежнему разный.
  const notifItems: { key: string; tone: 'red' | 'yellow' | 'green'; title: string; sub: string; go: string; ts: number }[] = []
  for (const t of taskAlerts) {
    const acts = t.progress?.actionsDone ?? t.progress?.done ?? 0
    let tone: 'red' | 'yellow' | 'green' = 'yellow'
    let sub = ''
    if (t.status === 'error') { tone = 'red'; sub = t.lastError ? `ошибка: ${t.lastError.slice(0, 40)}` : 'задача с ошибкой' }
    else if (t.pausedByCoins) { tone = 'red'; sub = 'остановлена: закончились монеты' }
    else if (t.status === 'running' && (t.errors ?? 0) > 0) { tone = 'red'; sub = `идёт с ошибками (${t.errors})` }
    else if ((t.floodWaits ?? 0) > 0) { tone = 'yellow'; sub = `упираемся в лимиты Telegram (FloodWait ×${t.floodWaits})` }
    else if (t.status === 'paused') { tone = 'yellow'; sub = 'на паузе — ожидание' }
    else if (t.status === 'queued') { tone = 'yellow'; sub = 'в очереди — ждёт слот' }
    else if (t.status === 'stopped') { tone = 'yellow'; sub = 'остановлена' }
    else if (t.status === 'done' && acts === 0) { tone = 'yellow'; sub = 'завершилась без действий' }
    else { tone = 'green'; sub = acts ? `выполнена · ${acts} действий` : 'выполнена' }
    notifItems.push({ key: `task:${t.id}`, tone, title: moduleTitle(t.moduleKey), sub, go: `/panel/tasks/${t.id}?m=${t.moduleKey}`, ts: t.updatedAt || t.createdAt || Date.now() })
  }
  for (const a of shown) {
    const deadProxy = a.proxyOk === false
    const banned = ['invalid', 'spamblock', 'frozen', 'reauth'].includes(a.status)
    const tone: 'red' | 'yellow' = (deadProxy || banned) ? 'red' : 'yellow'
    const sub = deadProxy ? 'прокси слетел (мёртвый)' : banned ? `аккаунт в бане/блоке (${a.status})` : a.noProxy ? 'без прокси — риск бана' : 'временное ограничение — ожидание'
    notifItems.push({ key: a.id, tone, title: a.name, sub, go: '/panel', ts: (a as { updatedAt?: number }).updatedAt || Date.now() })
  }
  // MR-134: 🟢 успешное пополнение баланса — только реальные пополнения/покупки (по reason),
  // недавние (12ч), а не любой служебный кредит/возврат, чтобы не засорять колокольчик.
  for (const w of wallet) {
    if (w.amount <= 0 || (Date.now() - w.ts) >= TASK_DONE_WINDOW || dismissed.has(`wallet:${w.ts}`)) continue
    if (!/пополнени|куплено|покупк/i.test(w.reason || '')) continue
    notifItems.push({ key: `wallet:${w.ts}`, tone: 'green', title: 'Пополнение баланса', sub: `${w.reason} · +${Math.round(w.amount * 1000) / 1000} ⚡`, go: '/panel/user/subscription', ts: w.ts })
  }
  // MR-134: 🟡 обращения в поддержку (не закрытые) — «ответ поддержки» / «ждём ответа».
  for (const tk of tickets) {
    if (tk.status === 'closed' || dismissed.has(`ticket:${tk.id}`)) continue
    const supReplied = tk.messages?.[tk.messages.length - 1]?.from === 'support'
    notifItems.push({ key: `ticket:${tk.id}`, tone: 'yellow', title: `Поддержка: ${tk.subject}`, sub: supReplied ? 'поддержка ответила' : 'ожидается ответ поддержки', go: '/panel/support', ts: tk.updatedAt || Date.now() })
  }
  // MR-134: 🟡 пропущенные ЛС — диалоги, ждущие нашего ответа дольше таймаута.
  if (awaiting.count > 0 && !dismissed.has('awaiting')) {
    // Клик ведёт прямо на диалог: выбираем аккаунт и открываем нужную переписку.
    // Раньше вело в пустой /panel/inbox (аккаунт не выбран — непонятно, где сообщение).
    const first = awaiting.items[0]
    const go = first
      ? `/panel/inbox?account=${encodeURIComponent(first.accountId)}&peer=${encodeURIComponent(first.peer)}`
      : '/panel/inbox'
    notifItems.push({ key: 'awaiting', tone: 'yellow', title: 'Пропущенные ЛС', sub: `${awaiting.count} ${awaiting.count === 1 ? 'диалог ждёт' : 'диалогов ждут'} ответа`, go, ts: Date.now() })
  }
  // MR-134 (12.08): сортируем ПО ВРЕМЕНИ — свежие сверху (а не группами ошибки→ожидание→готово).
  notifItems.sort((a, b) => b.ts - a.ts)
  // Стиль по тону (цвет остаётся разным, как просил заказчик): иконка/фон/подпись.
  const TONE_STYLE: Record<'red' | 'yellow' | 'green', { box: string; sub: string; icon: JSX.Element }> = {
    red: { box: 'bg-rose-500/12 text-rose-400', sub: 'text-rose-300/80', icon: <AlertTriangle size={15} /> },
    yellow: { box: 'bg-amber-500/12 text-amber-400', sub: 'text-amber-300/80', icon: <Clock size={15} /> },
    green: { box: 'bg-spark-500/12 text-spark-400', sub: 'text-spark-300/80', icon: <Check size={15} /> },
  }
  const alertCount = notifItems.length
  const hasRed = notifItems.some((i) => i.tone === 'red')
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const locale = useApp((s) => s.locale)
  const setLocale = useApp((s) => s.setLocale)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const sessionUser = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)
  // Права перечитываем с сервера: выданный или отозванный админом доступ должен
  // применяться в текущей сессии, а не «после перезахода» — про перезаход человеку
  // никто не скажет, а отзыв доступа, ждущий перелогина, это уже дыра.
  const refreshSession = useSession((s) => s.refresh)
  // Подписку тянем тем же тиком: оплатили модуль — он появляется в меню сам,
  // как и выданное админом право.
  const loadPlan = usePlan((s) => s.load)
  useEffect(() => {
    void refreshSession(); void loadPlan()
    const t = setInterval(() => { void refreshSession(); void loadPlan() }, 30000)
    return () => clearInterval(t)
  }, [refreshSession, loadPlan])
  const coinsOpen = useUi((s) => s.coinsOpen)
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)
  const noCoins = useUi((s) => s.noCoins)
  const setNoCoins = useUi((s) => s.setNoCoins)
  const noSubscription = useUi((s) => s.noSubscription)
  const setNoSubscription = useUi((s) => s.setNoSubscription)
  const [langOpenTick, setLangOpenTick] = useState(0)

  const active = activeAccounts(data).length
  const limit = balance?.plan.accountLimit ?? data.plan.accountLimit
  const currentLang = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[1]

  // R1/R2: шапка отражает залогиненного пользователя сессии (а не мок-профиль), + его роль.
  const displayName = sessionUser?.name || data.workspace
  const fullName = sessionUser?.name || `${data.user.firstName} ${data.user.lastName}`
  const email = sessionUser?.email || data.user.email
  const roleLabel = sessionUser ? (sessionUser.isAdmin ? 'Администратор' : (sessionUser.roleName || 'Роль не задана')) : null
  const doLogout = () => { logout(); setUserState('guest'); nav('/') }

  // §11.4: $ — основной кошелёк. Купить токены = потратить деньги со счёта (buyTokens
  // списывает $ и начисляет ⚡). Пополнение самих $ — через платёжку, которую ещё
  // подключают, поэтому пока показываем честный статус, а не делаем вид, что зачислили.
  const curSym = pricing?.currency || '$'
  const [buying, setBuying] = useState<number | null>(null)
  // Покупка списывает деньги со счёта СРАЗУ — поэтому сначала явное подтверждение
  // (человек жаловался: «нажал — и оно автоматом купило»). Без ok — ничего не списываем.
  const buyPack = async (price: number, coins: number) => {
    // §11.5: нельзя купить, если на счёте нет денег — сразу говорим «пополните», а не
    // даём подтвердить покупку, которую нечем оплатить.
    const bal = typeof balance?.usd === 'number' ? balance.usd : null
    if (bal != null && bal < price) {
      pushToast({ type: 'error', title: 'Недостаточно средств', desc: `На счёте ${curSym}${bal.toFixed(2)} — пополните счёт, чтобы купить за ${curSym}${price}.` })
      return
    }
    const ok = await confirmDialog({
      title: 'Купить токены',
      message: `Купить ${fmtCoins(coins)} ⚡ за ${curSym}${price}? Деньги спишутся со счёта сразу.`,
      confirmLabel: `Купить за ${curSym}${price}`,
    })
    if (!ok) return
    setBuying(price)
    try {
      const r = await buyTokens(price)
      setBalance(r.balance)
      pushToast({ type: 'success', title: `Куплено ${fmtCoins(r.tokens)} ⚡`, desc: `Списано ${curSym}${r.spentUsd.toFixed(2)}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось купить токены', desc: e instanceof Error ? e.message : 'Пополните $ на счёте' })
    } finally { setBuying(null) }
  }
  const TOPUP_USD = [10, 25, 50, 100]
  const [topupDraft, setTopupDraft] = useState('')
  const topUpUsd = (amount: number) => {
    if (!(amount > 0)) { pushToast({ type: 'error', title: 'Укажите сумму больше нуля' }); return }
    pushToast({ type: 'info', title: 'Пополнение $ скоро', desc: `Оплата на ${curSym}${amount} — подключаем платёжную систему (VIVA/Stripe).` })
  }
  const topUpCustom = () => {
    const v = Number(String(topupDraft).replace(',', '.'))
    if (!Number.isFinite(v) || v <= 0) { pushToast({ type: 'error', title: 'Нужна сумма', desc: 'Например 30' }); return }
    topUpUsd(Math.round(v * 100) / 100); setTopupDraft('')
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
      {/* Правка 14.08: кнопка сворачивания меню — у САМОГО левого края шапки (в пустом месте
          у края сайдбара), а не внутри центрированного контейнера. */}
      <button
        onClick={toggleSidebar}
        className="btn-icon absolute left-3 top-1/2 z-10 hidden -translate-y-1/2 lg:inline-flex"
        aria-label={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
        title={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-2 px-4 sm:px-6 lg:px-8 lg:pl-14">
        <button onClick={() => setMobileNav(true)} className="btn-icon lg:hidden" aria-label="Меню">
          <Menu size={18} />
        </button>

        {/* Plan badge */}
        <div className="hidden items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-1.5 sm:flex">
          <span className="text-xs font-medium text-muted">План</span>
          <span className="text-sm font-bold text-fg">{balance?.plan.name ?? data.plan.name}</span>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/* Парсинг данных CTA */}
          <button onClick={() => nav('/panel/modules/parsing')} className="btn-iris hidden h-9 px-3.5 md:inline-flex">
            <Radar size={16} /> Парсинг данных
          </button>

          {/* Accounts limit — кликабельно, ведёт в менеджер аккаунтов (правка 12.08). */}
          <button
            type="button"
            onClick={() => nav('/panel')}
            className="flex items-center gap-1.5 rounded-xl border border-line bg-elevated px-3 py-1.5 transition-colors hover:border-spark-500/40 hover:bg-elevated/70"
            title="Открыть менеджер аккаунтов"
          >
            <span className="text-sm font-bold text-fg">{active} / {limit}</span>
            <span className="hidden text-xs text-muted sm:inline">акк.</span>
          </button>

          {/* §6.3 (NOTIFY-001): колокольчик — сколько аккаунтов отвалилось (мёртвый прокси / нерабочий статус). */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setNotifOpen((v) => !v)}
              // Цвет колокольчика — по высшей severity: есть ошибки → красный, иначе жёлтый.
              className={`btn-icon relative ${!alertCount ? '' : hasRed ? 'text-rose-400' : 'text-amber-400'}`}
              aria-label="Уведомления"
              title={alertCount > 0 ? `Уведомлений: ${alertCount}` : 'Всё в порядке'}
            >
              <Bell size={18} />
              {alertCount > 0 && (
                <span className={`absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-none text-white ${hasRed ? 'bg-rose-500' : 'bg-amber-500'}`}>
                  {alertCount > 99 ? '99+' : alertCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <>
                <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/40">
                  <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
                      <Bell size={13} className={alertCount > 0 ? 'text-rose-400' : 'text-muted'} /> Уведомления · {alertCount}
                    </span>
                    {alertCount > 0 && <button onClick={dismissAll} className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-spark-300 transition-colors hover:bg-spark-500/10">Скрыть все</button>}
                  </div>
                  {alertCount === 0 ? (
                    <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
                      <Check size={22} className="text-spark-400" />
                      <span className="text-sm text-muted">Всё в порядке</span>
                    </div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto p-1.5">
                      {/* MR-134 (12.08): единый список ПО ВРЕМЕНИ (свежие сверху), у каждого — время;
                          цвет по типу (ошибка/ожидание/готово). Без группировки и без нижней кнопки. */}
                      {notifItems.slice(0, 30).map((i) => {
                        const st = TONE_STYLE[i.tone]
                        return (
                          <div key={i.key} className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-white/[.04]">
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${st.box}`}>{st.icon}</span>
                            <button onClick={() => { setNotifOpen(false); nav(i.go) }} className="min-w-0 flex-1 text-left">
                              <span className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-fg">{i.title}</span>
                                <span className="shrink-0 text-[10px] tabular-nums text-faint">{fmtNotifTs(i.ts)}</span>
                              </span>
                              <span className={`block text-[11px] ${st.sub}`}>{i.sub}</span>
                            </button>
                            <button onClick={() => dismiss(i.key)} title="Скрыть уведомление" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-white/10 hover:text-fg">
                              <X size={14} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Coins */}
          {/* §11.5: на нуле/почти нуле чип КРАСНЫЙ и со словом «Пополнить» — по звонку
              29.07 это критическое уведомление, оно должно тревожить, а не выглядеть
              спокойно-зелёным. Пороги — общие с лентой (LowBalanceBar). */}
          {/* §11.4: деньги и токены — РАЗДЕЛЬНО. По звонку 29.07 владельцу нужен
              отдельно долларовый баланс («баланс всегда в долларах») и отдельно
              количество токенов; «токены в долларах» одним числом — бесполезно.
              Курс монеты берём из пакетов пополнения (та же формула, что на сервере). */}
          {(() => {
            const c = balance?.coins ?? data.coins
            // §11.4: деньги — ОТДЕЛЬНЫЙ остаток с сервера, а не пересчёт токенов по
            // курсу. Владелец: «баланс — это $, за них покупаем подписки и токены».
            // Пока миграция usd-кошелька не применена, поле не приходит — тогда
            // показываем только токены, а не выдуманный ноль долларов.
            const usd = typeof balance?.usd === 'number' ? balance.usd : null
            const tokensLow = c <= CRITICAL
            const usdLow = usd != null && usd <= 0
            // MR-166 (14.08): цвет чипа определяют ТОКЕНЫ, а не деньги. Раньше нулевой
            // долларовый остаток красил всё в красный при полном балансе токенов, и
            // заказчик читал это как аварию: «наша система работает на токенах, оно
            // должно смотреть на токены в первую очередь». Деньги остаются видны и
            // подсвечиваются отдельно, но общей тревоги больше не поднимают.
            const alarm = tokensLow
            // Запас есть — чип зелёный. Порог 500 задан заказчиком на созвоне 14.08.
            const tokensHealthy = c >= HEALTHY_COINS
            const cur = pricing?.currency || '$'
            return (
              <button
                onClick={() => setCoinsOpen(true)}
                title={tokensLow ? 'Токены на нуле — пополнить'
                  : usdLow ? 'Токены есть, но денег на счёте нет'
                    : 'Деньги и токены'}
                className={
                  'flex items-center gap-2 rounded-xl border px-3 py-1.5 transition-colors ' +
                  (alarm
                    ? 'border-red-500/50 bg-red-500/15 hover:bg-red-500/25'
                    : tokensHealthy
                      ? 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15'
                      : 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15')
                }
              >
                {usd != null && (
                  <span className={'text-sm font-bold tabular-nums ' + (usdLow ? 'text-red-300' : 'text-fg')}>
                    {cur}{usd.toFixed(2)}
                  </span>
                )}
                <span className={'flex items-center gap-1 ' + (usd != null ? 'border-l border-white/10 pl-2' : '')}>
                  <Zap size={15} className={tokensLow ? 'text-red-400' : tokensHealthy ? 'text-emerald-400' : 'text-amber-400'} fill="currentColor" />
                  <span className={'text-sm font-bold tabular-nums ' + (tokensLow ? 'text-red-300' : tokensHealthy ? 'text-emerald-300' : 'text-amber-300')}>{fmtCoins(c)}</span>
                </span>
                {alarm && <span className="text-xs font-bold text-red-300">Пополнить</span>}
              </button>
            )
          })()}

          {/* Theme */}
          <button onClick={toggleTheme} className="btn-icon" aria-label="Тема">
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          {/* Language */}
          <Dropdown
            width={180}
            trigger={({ toggle }) => (
              <button onClick={() => { toggle(); setLangOpenTick((t) => t + 1) }} className="btn-icon w-auto gap-1 px-2.5">
                <span className="text-sm font-bold uppercase">{currentLang.code === 'ru' ? 'RU' : currentLang.code === 'ua' ? 'UA' : 'EN'}</span>
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <div key={langOpenTick}>
                {LANGUAGES.map((l) => (
                  <MenuItem
                    key={l.code}
                    onClick={() => {
                      setLocale(l.code as 'ru' | 'en' | 'ua')
                      close()
                      if (l.code !== 'ru') pushToast({ type: 'info', title: 'Интерфейс доступен только на русском', desc: 'Другие языки появятся позже.' })
                    }}
                    icon={<span className="text-base">{l.flag}</span>}
                  >
                    <span className="flex-1">{l.label}</span>
                    {locale === l.code && <Check size={15} className="text-spark-400" />}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>

          {/* User menu */}
          <Dropdown
            width={240}
            trigger={({ toggle }) => (
              <button onClick={toggle} className="flex items-center gap-2 rounded-xl border border-line bg-elevated py-1 pl-1 pr-2 transition-colors hover:border-spark-500/30">
                <Avatar name={displayName} color="#7145ff" size={30} />
                <span className="hidden text-sm font-semibold text-fg sm:inline">{displayName}</span>
                <ChevronDown size={14} className="hidden text-muted sm:inline" />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="border-b border-line px-3 py-2.5">
                  <div className="text-sm font-bold text-fg">{fullName}</div>
                  <div className="text-xs text-muted">{email}</div>
                  {roleLabel && (
                    <span className={`mt-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${sessionUser?.isAdmin ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300'}`}>
                      {sessionUser?.isAdmin ? 'Администратор' : `Роль: ${roleLabel}`}
                    </span>
                  )}
                </div>
                <div className="py-1">
                  <MenuItem icon={<UserCog size={16} />} onClick={() => { nav('/panel/user/profile'); close() }}>Мой аккаунт</MenuItem>
                  <MenuItem icon={<Wallet size={16} />} onClick={() => { setCoinsOpen(true); close() }}>Пополнить токены</MenuItem>
                  <MenuItem icon={<LogOut size={16} />} tone="danger" onClick={() => { doLogout(); close() }}>Выйти</MenuItem>
                </div>
              </>
            )}
          </Dropdown>
        </div>
      </div>

      {/*
        Нулевой баланс: окно по центру вместо тоста в углу. Запуск не состоялся —
        значит человеку нужно не уведомление, а следующий шаг, и кнопка ведёт
        прямо в пополнение, а не оставляет искать его в меню.
      */}
      <Modal
        open={!!noCoins}
        onClose={() => setNoCoins('')}
        title="Недостаточно монет"
        subtitle="Модули остановлены"
        icon={<AlertTriangle size={22} />}
        size="sm"
        footer={(
          <>
            <button onClick={() => setNoCoins('')} className="btn-ghost">Закрыть</button>
            {/* §11.5: «Пополнить» — красным, а не зелёным btn-primary: это тревожное
                уведомление, а не радостное действие. */}
            <button
              onClick={() => { setNoCoins(''); setCoinsOpen(true) }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-400"
            >
              <Zap size={16} fill="currentColor" /> Пополнить баланс
            </button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed text-muted">{noCoins}</p>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <span className="text-sm font-medium text-muted">Текущий баланс</span>
          <span className="flex items-center gap-1.5 font-display text-xl font-bold text-amber-300">
            <Zap size={18} fill="currentColor" /> {fmtCoins(balance?.coins ?? 0)}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted">
          Платные все модули, включая сбор данных. Цены по действиям — в окне «Пополнить баланс».
        </p>
      </Modal>

      {/* Модуль не оплачен — это не про монеты, и путь отсюда в кабинет. */}
      <Modal
        open={!!noSubscription}
        onClose={() => setNoSubscription('')}
        title="Модуль не оплачен"
        subtitle="Его нет в вашей подписке"
        icon={<Package size={22} />}
        size="sm"
        footer={(
          <>
            <button onClick={() => setNoSubscription('')} className="btn-ghost">Закрыть</button>
            <button
              onClick={() => { setNoSubscription(''); nav('/panel/user/subscription') }}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <Package size={16} /> Подписки
            </button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed text-muted">{noSubscription}</p>
        <p className="mt-3 text-xs text-muted">
          Подписка и монеты — разные вещи: монеты тратятся на действия внутри модуля,
          подписка открывает сам модуль. Менять набор может владелец рабочего пространства.
        </p>
      </Modal>

      {/* Coins modal */}
      <Modal
        open={coinsOpen}
        onClose={() => setCoinsOpen(false)}
        title="Кошелёк"
        subtitle="Деньги, токены и подключённые модули"
        icon={<Wallet size={22} />}
        size="md"
      >
        {/* §11.4: ДЕНЬГИ ($) — основное, крупно и первым; токены ⚡ — вторично.
            Разделение со звонка: «баланс — это $, за них покупаем подписки и токены». */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-spark-500/40 bg-spark-500/8 px-4 py-3.5">
            <div className="text-xs font-medium text-muted">Деньги на счету</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-display text-2xl font-bold text-spark-200">
              {curSym}{(balance?.usd ?? 0).toFixed(2)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted">за них — подписки и токены</div>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5">
            <div className="text-xs font-medium text-muted">Токены (топливо)</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-display text-2xl font-bold text-amber-300">
              <Zap size={20} fill="currentColor" /> {fmtCoins(balance?.coins ?? data.coins)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted">тратятся за каждое действие</div>
          </div>
        </div>

        {/* §11.4: в кошельке лежит всё, что человек взял за $ — не только деньги и токены,
            но и открытые модули (подписка). Держим это в одном месте, а не по разным экранам. */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Подписки</span>
            <button onClick={() => { setCoinsOpen(false); nav('/panel/user/subscription') }} className="text-xs text-spark-300 hover:text-spark-200">Изменить →</button>
          </div>
          {(() => {
            const mods = balance?.modules
            if (mods === 'all' || mods == null) return <div className="text-sm text-muted">Открыты <b className="text-fg">все модули</b> (набор не выбран).</div>
            if (!mods.length) return <div className="text-sm text-muted">Модули не подключены — оформите подписку за {curSym}.</div>
            return (
              <div className="flex flex-wrap gap-1.5">
                {mods.map((k) => (
                  <span key={k} className="rounded-lg border border-spark-500/30 bg-spark-500/8 px-2 py-1 text-xs text-spark-200">{moduleTitle(k)}</span>
                ))}
              </div>
            )
          })()}
        </div>

        {/* Пополнить $ — основная валюта. Оплата подключается (VIVA/Stripe), пока — честный статус. */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Пополнить счёт ({curSym})</div>
          <div className="grid grid-cols-4 gap-2">
            {TOPUP_USD.map((a) => (
              <button
                key={a}
                onClick={() => topUpUsd(a)}
                className="flex flex-col items-center gap-0.5 rounded-xl border border-line bg-card py-2.5 transition-colors hover:border-spark-500/40 hover:text-spark-200"
              >
                <span className="font-display text-lg font-bold text-fg">{curSym}{a}</span>
              </button>
            ))}
          </div>
          {/* Своя сумма — не только шаблоны: человек вводит сколько хочет. */}
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">{curSym}</span>
              <input
                value={topupDraft}
                onChange={(e) => setTopupDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') topUpCustom() }}
                inputMode="decimal"
                placeholder="своя сумма"
                className="input h-9 w-full pl-7 text-sm"
              />
            </div>
            <button onClick={topUpCustom} className="btn-ghost h-9 rounded-xl border border-line px-3 text-sm hover:border-spark-500/40 hover:text-spark-200">Пополнить</button>
          </div>
        </div>

        {/* Обменять деньги на токены: списываем $ со счёта и начисляем ⚡ (buyTokens). */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Купить токены за {curSym} со счёта</div>
          {(() => {
            // §11.5: денег на счёте нет — покупать нечем; пакеты недоступны, а не «жмётся,
            // но падает с ошибкой». Если usd-кошелёк ещё не пришёл (null) — не блокируем.
            const usdBal = typeof balance?.usd === 'number' ? balance.usd : null
            return (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {(pricing?.packs?.length ? pricing.packs : FALLBACK_PACKS).map((p) => {
                    const cantAfford = usdBal != null && usdBal < p.price
                    return (
                      <button
                        key={p.coins}
                        onClick={() => void buyPack(p.price, p.coins)}
                        disabled={buying !== null || cantAfford}
                        title={cantAfford ? `Недостаточно средств: на счёте ${curSym}${usdBal?.toFixed(2)}` : undefined}
                        className={`relative flex flex-col items-center gap-1 rounded-2xl border p-4 transition-all enabled:hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45 ${p.best ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated'}`}
                      >
                        {p.best && <span className="absolute -top-2 rounded-full bg-spark-gradient px-2 py-0.5 text-[10px] font-bold text-[#04150c]">ВЫГОДНО</span>}
                        <Zap size={22} className="text-amber-400" fill="currentColor" />
                        <span className="font-display text-xl font-bold text-fg">{p.coins}</span>
                        <span className="text-sm font-semibold text-muted">{p.price} {curSym}</span>
                        {/* Цена монеты в пакете: «выгодно» должно быть посчитано, а не заявлено. */}
                        <span className="text-[10px] text-faint">{(p.price / p.coins).toFixed(3)} {curSym} / ⚡</span>
                      </button>
                    )
                  })}
                </div>
                {usdBal != null && usdBal <= 0 && (
                  <div className="mt-2.5 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-200">
                    На счёте {curSym}0.00 — сначала пополните счёт, тогда можно купить токены.
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {/* Прайс: человек должен видеть, за что уходят токены, до покупки, а не после. */}
        {pricing && (
          <div className="rounded-2xl border border-line bg-elevated/50 p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Сколько стоит действие</div>
            <div className="max-h-40 overflow-y-auto pr-1">
              {pricing.items.map((p) => (
                <div key={p.key} className="flex items-center justify-between border-b border-line/50 py-1 text-sm last:border-0">
                  <span className="text-muted">{p.title}</span>
                  <span className="font-semibold tabular-nums text-fg">{p.price} ⚡</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </header>
  )
}
