import { coins as fmtCoins, cn } from '@/shared/lib/utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Users, ListChecks, Coins, Download, RefreshCw, AlertTriangle, Contact, Power, ChevronDown, Activity, Plus, Radar, Search, ShoppingCart, Loader2, Check, Trash2, ScrollText, Send, MessageSquare, LifeBuoy, ArrowLeft } from 'lucide-react'
import { PageHeader, Card, Segmented, EmptyState, Select, Badge } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import {
  fetchAdminOverview, fetchClientReport, fetchUsersReport, fetchProblems, fetchCrmOverview,
  fetchActiveNow, fetchDailySpend, fetchPurchases, fetchPayments, fetchAccountsHealth, fetchUserActivity, type UserActivity, fetchUserDialogs, type UserDialogs, fetchMessages, type MessageRow,
  fetchEconomy, type Economy,

  type AdminOverview, type ClientReport, type UsersReport, type Problems, type CrmOverview,
  type ActiveNow, type ActiveTask, type DailySpend, type Purchases, type PaymentsResult, type UserRow, type AccountsHealth, fetchPrices, savePrices, type EffectivePrices, type PricePatch,
  fetchTaskLogs, type FailedTask, type TaskLogs } from '@/api/adminApi'
import { updateUser } from '@/api/usersApi'
import { fetchTickets, fetchTicket, replyTicket, setTicketStatus, fetchTicketsUnread, type ApiTicket, type TicketStatus } from '@/api/ticketsApi'
import { TicketChat, shortId } from '@/features/support/TicketChat'
import { fetchTgstatSession, uploadTgstatSession, verifyTgstatSession, clearTgstatSession, type TgstatSession } from '@/api/tgstatApi'
import { fetchRoles } from '@/api/rolesApi'
import { RolesPage } from '@/pages/RolesPage'
import { changeBalance, fetchSubscription, saveUserModules, fetchWalletHistory, type WalletEntry } from '@/api/balanceApi'
import { promptDialog } from '@/shared/lib/dialog'
import { ApiDocsTab } from '@/features/billing/ApiDocsTab'
import { fmt, fmtDate, cleanPrice, fmtUsd, usdEq, MetricTile } from '@/pages/admin/adminShared'
import { MonitoringTab, AccountsHealthBlocks } from '@/pages/admin/MonitoringTab'
import { AccountsTab } from '@/pages/admin/AccountsTab'
import { BundlesEditor } from '@/pages/admin/BundlesEditor'
import { useTabParam } from '@/shared/lib/useTabParam'
import { LeadConversationModal } from '@/features/leads/LeadConversationModal'

/**
 * §5.3 (E1/E2): админ-панель со статистикой и постатейный отчёт клиенту.
 *
 * Два экрана намеренно на одной странице: числа в отчёте и числа в панели должны
 * совпадать, а собираются они одним запросом на сервере — расхождение «инвойса»
 * с тем, что видит оператор, здесь худшее из возможного.
 */

/**
 * `days: 0` — «всё время»: since уходит в 0, а не «сегодня минус ноль дней».
 * Без этого варианта нельзя ответить на «сколько он потратил всего», а именно это
 * и спрашивают, когда разбирают счёт.
 */
const PERIODS = [
  { label: 'День', days: 1 },
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
  { label: 'Всё время', days: 0 },
]

/**
 * Вкладки, где переключатель периода бессмыслен и только сбивает с толку:
 * «Сейчас» (1) и «Мониторинг» (10) — снимки текущего состояния сервера и задач;
 * «Цены» (6), «Роли» (12), «Тикеты» (13), «Парсер» (14), «API» (15) — справочники
 * и настройки, фильтровать их по времени нечем.
 */
const PERIODLESS_TABS = new Set([1, 6, 10, 12, 13, 14, 15])

/**
 * Вкладки, которым автообновление НЕ нужно (статичные справочники/конфиг): Цены, Роли,
 * Тикеты, Парсер, API. На них тумблер «Автообновление» скрыт и фон не тикает. «Сейчас» и
 * «Мониторинг» — живые, там автообновление ОСТАЁТСЯ.
 */
/** Индекс вкладки «Тикеты» — у неё автообновление своё (список обращений, не статистика). */
const TICKETS_TAB = 13
// Справочные вкладки, где обновлять по таймеру нечего: цены (6), роли (12), парсер (14), API (15).
// «Тикеты» (13) СЮДА НЕ ВХОДЯТ: это живая переписка, её надо тянуть автоматически.
const NO_AUTOREFRESH_TABS = new Set([6, 12, 14, 15])

const STATUS_RU: Record<string, string> = {
  active: 'Активные', working: 'В работе', warming: 'Прогрев', pause: 'На паузе',
  floodwait: 'FloodWait', quarantine: 'Карантин', spamblock: 'Спамблок',
  invalid: 'Невалидные', reauth: 'Реавторизация', frozen: 'Отключены',
  done: 'Готово', running: 'Выполняется', stopped: 'Остановлены', queued: 'В очереди', error: 'Ошибка', paused: 'Пауза',
}


export function AdminStatsPage() {
  const pushToast = useApp((s) => s.pushToast)
  // Вкладка в адресе (?tab=) — F5 больше не выбрасывает на первую.
  const [tab, setTab] = useTabParam<number>(0)
  // Значок непрочитанных обращений на вкладке «Тикеты» (сторона поддержки).
  const [ticketsUnread, setTicketsUnread] = useState(0)
  useEffect(() => {
    let alive = true
    const tick = () => { void fetchTicketsUnread(true).then((n) => { if (alive) setTicketsUnread(n) }) }
    tick()
    const id = setInterval(tick, 20000)
    return () => { alive = false; clearInterval(id) }
  }, [tab])
  const [periodIdx, setPeriodIdx] = useState(2)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [report, setReport] = useState<ClientReport | null>(null)
  const [users, setUsers] = useState<UsersReport | null>(null)
  const [problems, setProblems] = useState<Problems | null>(null)
  const [crm, setCrm] = useState<CrmOverview | null>(null)
  const [active, setActive] = useState<ActiveNow | null>(null)
  const [daily, setDaily] = useState<DailySpend | null>(null)
  const [purchases, setPurchases] = useState<Purchases | null>(null)
  const [health, setHealth] = useState<AccountsHealth | null>(null)
  const [economy, setEconomy] = useState<Economy | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)

  const since = useMemo(() => {
    const d = PERIODS[periodIdx].days
    return d ? Date.now() - d * 24 * 60 * 60 * 1000 : 0
  }, [periodIdx])

  // §5.1 (MR-31): при смене периода отменяем предыдущий запрос (AbortController) и не
  // применяем его результат (проверка signal.aborted), чтобы медленный ответ старого
  // периода не перезаписал новый. Данные периода чистим сразу — под новым периодом не
  // должны висеть цифры старого; вкладки при пустых данных показывают «Загрузка…».
  const loadCtl = useRef<AbortController | null>(null)
  // §5.1 (MR-32): кэш загруженных периодов — при возврате на уже виденный период
  // показываем данные мгновенно, без повторного запроса. Ключ — periodIdx (стабилен),
  // TTL 60с — чтобы не держать вечно устаревшее; «Обновить» игнорирует кэш (force).
  type StatsSnap = { o: AdminOverview; r: ClientReport; u: UsersReport; p: Problems; c: CrmOverview; a: ActiveNow; d: DailySpend; pur: Purchases; h: AccountsHealth; econ: Economy }
  const CACHE_TTL = 60_000
  const cacheRef = useRef<Map<number, { snap: StatsSnap; ts: number }>>(new Map())
  const applySnap = (s: StatsSnap) => {
    setOverview(s.o); setReport(s.r); setUsers(s.u); setProblems(s.p); setCrm(s.c)
    setActive(s.a); setDaily(s.d); setPurchases(s.pur); setHealth(s.h); setEconomy(s.econ); setDenied(false)
  }
  // §5.2 (MR-33): busyRef — идёт ли «видимая» (не фоновая) загрузка; автообновление
  // пропускает тик, пока она идёт, чтобы фон не перебивал ручную загрузку/смену периода.
  const busyRef = useRef(false)
  const load = async ({ force = false, silent = false }: { force?: boolean; silent?: boolean } = {}) => {
    loadCtl.current?.abort()
    const ctl = new AbortController()
    loadCtl.current = ctl
    const { signal } = ctl
    // Свежий кэш периода → мгновенно, без запроса (MR-32). Фоновое автообновление (silent)
    // всегда идёт с force, поэтому кэш ему не мешает тянуть свежие данные.
    const cached = cacheRef.current.get(periodIdx)
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL) { applySnap(cached.snap); setLoading(false); return }
    // Фоновое обновление не трогает спиннер и не чистит область — данные меняются на месте,
    // без мигания; видимую загрузку показываем только при смене периода/«Обновить».
    if (!silent) {
      busyRef.current = true
      setLoading(true)
      // Чистим period-зависимые данные (Сейчас/Мониторинг — состояние «сейчас», не период — не трогаем).
      setOverview(null); setReport(null); setUsers(null); setProblems(null); setCrm(null); setDaily(null); setPurchases(null); setEconomy(null)
    }
    try {
      // Грузим всё одним заходом: цифры на разных вкладках должны быть на один момент
      // времени, иначе «в панели 82 задачи, а по людям 80» читается как ошибка счёта.
      const [o, r, u, p, c, a, d, pur, h, econ] = await Promise.all([
        fetchAdminOverview(since, signal), fetchClientReport(since, undefined, signal),
        fetchUsersReport(since, signal), fetchProblems(since, signal), fetchCrmOverview(since, signal),
        fetchActiveNow(signal), fetchDailySpend(PERIODS[periodIdx].days || 90, signal), fetchPurchases(since, signal),
        fetchAccountsHealth(signal), fetchEconomy(since, signal),
      ])
      if (signal.aborted) return // перебит новым периодом — результат не применяем
      const snap: StatsSnap = { o, r, u, p, c, a, d, pur, h, econ }
      cacheRef.current.set(periodIdx, { snap, ts: Date.now() }) // кэшируем загруженный период
      applySnap(snap)
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return // отмена — не ошибка
      // 403 — не ошибка сборки, а честный отказ: показываем это отдельно, иначе
      // оператор будет думать, что страница сломалась.
      const msg = e instanceof Error ? e.message : ''
      if (/администратор/i.test(msg)) setDenied(true)
      else pushToast({ type: 'error', title: 'Не удалось загрузить статистику', desc: msg })
    } finally {
      // loading/busy снимает только текущий видимый загрузчик; фоновый (silent) их не трогал.
      if (loadCtl.current === ctl && !silent) { busyRef.current = false; setLoading(false) }
    }
  }
  useEffect(() => { void load() }, [since]) // eslint-disable-line react-hooks/exhaustive-deps

  // Интервал автообновления стабилен (deps [autoRefresh]), но обязан звать АКТУАЛЬНУЮ
  // load (текущий период) и знать ТЕКУЩУЮ вкладку. Иначе фон тянул данные периода по
  // умолчанию и затирал выбранный. Держим свежие значения в ref-ах.
  const loadRef = useRef(load)
  loadRef.current = load
  const tabRef = useRef(tab)
  tabRef.current = tab
  // На вкладке «Тикеты» общий цикл обновляет НЕ статистику, а список обращений: вкладка
  // сама регистрирует здесь свою тихую перезагрузку. Так тумблер и отсчёт остаются одни
  // на всю админку, а тянется ровно то, что показано на экране.
  const ticketsReloadRef = useRef<(() => Promise<void>) | null>(null)
  const registerTicketsReload = useCallback((fn: (() => Promise<void>) | null) => { ticketsReloadRef.current = fn }, [])

  // §5.2 (MR-33): автообновление — раз в 15с (в пределах 10–30с из ТЗ) молча тянем свежие
  // данные текущего периода и состояний «сейчас» (мониторинг/задачи/ошибки), без спиннера и
  // без мигания. Пропускаем тик, когда вкладка скрыта (не долбим сервер в фоне), при отказе
  // доступа и пока идёт видимая загрузка. Тумблер позволяет выключить.
  const AUTO_REFRESH_SEC = 15
  const [autoRefresh, setAutoRefresh] = useState(true)
  // Обновление молчаливое, и по экрану не понять, работает ли оно вообще. Поэтому
  // рядом с тумблером — обратный отсчёт до следующего тика.
  //
  // Счётчик виден ВСЕГДА, а отметка «обновлено» показывается РЯДОМ с ним: если ею
  // подменять счётчик, секунда «15» проглатывается и выглядит так, будто сначала
  // обновилось, а потом заново пошёл отсчёт. Порядок теперь честный:
  //   3с → 2с → 1с → 0с (идёт запрос) → ✓ 15с → 14с → …
  const [secLeft, setSecLeft] = useState(AUTO_REFRESH_SEC)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Ref, а не state: защита от повторного запуска должна срабатывать синхронно внутри
  // тика — state обновится только к следующему рендеру и второй запрос бы проскочил.
  const refreshingRef = useRef(false)
  /** Пока true — счётчик стоит: на экране «обновлено», отсчёт ещё не начался. */
  const justRefreshedRef = useRef(false)
  useEffect(() => {
    if (!autoRefresh) { setSecLeft(AUTO_REFRESH_SEC); setJustRefreshed(false); setRefreshing(false); return }
    const id = setInterval(() => {
      // Вкладка скрыта, отказ доступа, конфиг-вкладка (автообновление не нужно) или идёт
      // видимая загрузка — не тикаем и не дёргаем сервер; счётчик замирает.
      if (denied || busyRef.current || NO_AUTOREFRESH_TABS.has(tabRef.current)) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      // Пока горит «обновлено» — счётчик стоит: сначала человек видит факт обновления,
      // и только потом отсчёт стартует заново с 15. Иначе галочка и новый отсчёт
      // наезжали друг на друга.
      if (justRefreshedRef.current) return
      setSecLeft((s) => {
        if (s > 1) return s - 1
        // Дошли до нуля — идём за данными. Отсчёт перезапускаем ПОСЛЕ ответа: пока
        // запрос в полёте, на экране «0с» и спиннер, то есть счётчик не врёт, будто
        // до обновления ещё 15 секунд.
        //
        // Запуск живёт внутри тика (а не отдельным эффектом по secLeft===0) намеренно:
        // если в этот момент шла ручная загрузка, тик просто пропускается и повторит
        // попытку через секунду. Отдельный эффект в такой ситуации залипал бы на нуле
        // навсегда — его зависимости больше не менялись бы.
        if (refreshingRef.current) return 0
        refreshingRef.current = true
        setRefreshing(true)
        // На «Тикетах» тянем переписку (её зарегистрировала сама вкладка), иначе — статистику.
        const pull = tabRef.current === TICKETS_TAB && ticketsReloadRef.current
          ? ticketsReloadRef.current()
          : loadRef.current({ force: true, silent: true })
        void pull.finally(() => {
          refreshingRef.current = false
          setRefreshing(false)
          // Сначала показываем, что обновилось (счётчик на паузе), и только через
          // секунду запускаем отсчёт заново — как просил заказчик.
          justRefreshedRef.current = true
          setJustRefreshed(true)
          setTimeout(() => {
            justRefreshedRef.current = false
            setJustRefreshed(false)
            setSecLeft(AUTO_REFRESH_SEC)
          }, 1200)
        })
        return 0
      })
    }, 1000)
    return () => clearInterval(id)
  }, [autoRefresh, denied]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Выгрузка «инвойса» в CSV — отчёт нужно отправить, а не показать на экране.
      Принимает отображаемый отчёт (общий или по конкретному клиенту). */
  const exportCsv = (rep: ClientReport | null = report) => {
    if (!rep?.rows.length) return
    // Монеты разбиты на две статьи: видно, за что именно списано — за сами действия
    // по прайсу и отдельно за работу ИИ.
    const head = ['Модуль', 'Задач', 'Завершено', 'Действий', 'Токенов', 'Монет за действия', 'Монет за ИИ', 'Монет всего']
    const lines = [
      `Отчёт за период ${fmtDate(rep.since)} — ${fmtDate(rep.until)}`,
      head.join(';'),
      ...rep.rows.map((r) => [r.title, r.tasks, r.completed, r.actions, r.tokens, r.actionCoins ?? 0, r.tokenCoins ?? 0, r.coins].join(';')),
      ['ИТОГО', rep.totals.tasks, '', rep.totals.actions, rep.totals.tokens,
       rep.totals.actionCoins ?? 0, rep.totals.tokenCoins ?? 0, rep.totals.coins].join(';'),
    ]
    // BOM — иначе Excel открывает кириллицу кракозябрами, и отчёт нечитаем.
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `otchet-${fmtDate(rep.since)}-${fmtDate(rep.until)}.csv`.replace(/\./g, '-')
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (denied) {
    return (
      <div>
        <PageHeader title="Админ-панель" subtitle="Сводка по системе, деньги и отчёт клиенту" icon={<BarChart3 size={22} />} />
        <Card className="p-6">
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="Доступно только администратору"
            desc="Здесь данные по всем пользователям и деньгам, поэтому раздел закрыт для остальных ролей."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Админ-панель"
        subtitle="Сводка по системе, деньги, покупки и постатейный отчёт клиенту"
        icon={<BarChart3 size={22} />}
        actions={
          <div className="flex items-center gap-3">
            {/* Автообновление — только на живых/данных-вкладках; на справочниках (Цены, Роли,
                Тикеты, Парсер, API) скрыто: там обновлять по таймеру нечего. */}
            {!NO_AUTOREFRESH_TABS.has(tab) && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted" title="Обновлять данные каждые 15 секунд без перезагрузки страницы">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-spark-500" />
              Автообновление
              {/* Видимое доказательство, что цикл живой. Счётчик НЕ подменяем: галочка
                  и спиннер живут рядом, поэтому не теряется ни одна секунда отсчёта. */}
              {autoRefresh && (
                justRefreshed ? (
                  // Сначала — факт обновления, счётчик на паузе. Через секунду вернётся отсчёт.
                  <span className="inline-flex items-center gap-1 rounded-md bg-spark-500/15 px-1.5 py-0.5 font-semibold text-spark-300" title="Данные только что обновлены">
                    <Check size={11} strokeWidth={3} /> обновлено
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    {refreshing && <Loader2 size={11} className="animate-spin text-spark-300" />}
                    <span
                      className="inline-flex min-w-[34px] justify-center rounded-md bg-white/6 px-1.5 py-0.5 font-mono tabular-nums text-fg/70"
                      title={refreshing ? 'Идёт обновление…' : 'Секунд до следующего обновления'}
                    >
                      {secLeft}с
                    </span>
                  </span>
                )
              )}
            </label>
            )}
            <button onClick={() => void load({ force: true })} className="btn-ghost h-10" disabled={loading}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Обновить
            </button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented options={['Панель', 'Сейчас', 'По дням', 'Пользователи', 'Покупки', 'Экономика', 'Цены', 'Задачи и ошибки', 'CRM', 'Отчёт', 'Мониторинг', 'Аккаунты', 'Роли', ticketsUnread > 0 ? `Тикеты (${ticketsUnread})` : 'Тикеты', 'Парсер', 'API']} value={tab} onChange={setTab} />
        {/* Период показываем только там, где он реально фильтрует. «Сейчас» (1) и
            «Мониторинг» (10) — снимки текущего состояния сервера и задач: период на
            них не влияет и только сбивал с толку. То же для справочных вкладок
            (цены, роли, тикеты, парсер, API) — там нечего фильтровать по времени. */}
        {!PERIODLESS_TABS.has(tab) && (
          // Пока грузится статистика выбранного периода — остальные периоды заблокированы
          // (каждый период тянет свой запрос; не даём накликать гонку и путаницу).
          <Segmented options={PERIODS.map((p) => p.label)} value={periodIdx} onChange={setPeriodIdx} size="sm" disabled={loading} />
        )}
      </div>

      {loading && !overview ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted">
          <RefreshCw size={15} className="animate-spin" /> Загрузка данных за период «{PERIODS[periodIdx].label}»…
        </Card>
      ) : tab === 0 ? (
        <PanelTab o={overview} />
      ) : tab === 1 ? (
        <ActiveTab active={active} onReload={load} />
      ) : tab === 2 ? (
        <DailyTab daily={daily} />
      ) : tab === 3 ? (
        <UsersTab report={users} onReload={load} />
      ) : tab === 4 ? (
        <PurchasesTab p={purchases} />
      ) : tab === 5 ? (
        /* §3.3 (MR-23): экономика — доходы, расходы, маржа, разрез по серверам. */
        <EconomyTab economy={economy} />
      ) : tab === 6 ? (
        <PricesTab />
      ) : tab === 7 ? (
        <ProblemsTab p={problems} health={health} />
      ) : tab === 8 ? (
        <CrmTab crm={crm} />
      ) : tab === 9 ? (
        <ReportTab report={report} onExport={exportCsv} users={users?.rows || []} since={since} />
      ) : tab === 10 ? (
        <MonitoringTab health={health} active={active} daily={daily} />
      ) : tab === 11 ? (
        /* §10.10: управление аккаунтами из sudo-админки — список всех + пауза/запуск/стоп. */
        <AccountsTab />
      ) : tab === 12 ? (
        /* §10.4: управление ролями доступа — из sudo-админки (создание/права/блоки). */
        <RolesPage />
      ) : tab === 13 ? (
        /* §8 (MR-44): тикеты поддержки — поддержка видит все, отвечает, двигает статус. */
        <AdminTicketsTab autoRefresh={autoRefresh} registerReload={registerTicketsReload} />
      ) : tab === 14 ? (
        /* §6 (MR-40b): сессия каталог-парсера (cookies) — управление из админки. */
        <AdminParserSessionTab />
      ) : (
        <ApiDocsTab />
      )}
    </div>
  )
}

function Tile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">{icon} {label}</div>
      <div className="font-display text-2xl font-bold text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  )
}

function Breakdown({ title, data, ru }: { title: string; data: Record<string, number>; ru?: boolean }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (!rows.length) return null
  const max = rows[0][1] || 1
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-semibold text-fg">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-xs text-muted">{ru ? (STATUS_RU[k] || k) : k}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
              <div className="h-full rounded-full bg-spark-500/70" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{fmt(v)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function PanelTab({ o }: { o: AdminOverview | null }) {
  if (!o) return <Card className="p-6 text-sm text-muted">Нет данных</Card>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* «Аккаунт» — управляемый Telegram-бот, «пользователь» — человек в системе.
            Рядом с карточкой про кошельки пользователей голое слово «Аккаунты»
            читалось как «людей 5», хотя людей двое. Называем вещи полностью. */}
        <Tile
          icon={<Radar size={14} />} label="Telegram-аккаунты" value={fmt(o.accounts.total)}
          hint={`${o.accounts.resting} отдыхают · ${o.accounts.tired} устают`}
        />
        <Tile
          icon={<Users size={14} />} label="Пользователей" value={fmt(o.users.total)}
          hint={`${o.users.active} активных · люди, а не боты`}
        />
        <Tile icon={<ListChecks size={14} />} label="Задач за период" value={fmt(o.tasks.total)} />
        <Tile
          icon={<Coins size={14} />} label="Израсходовано" value={`${fmt(o.tokens.tokens)} ток.`}
          hint={`${fmtCoins(o.tokens.coins)} ⚡ за ИИ · ${fmt(o.tokens.calls)} запросов`}
        />
        <Tile
          icon={<Coins size={14} />} label="Монет в системе"
          value={o.coinTotal ? fmtCoins(o.coinTotal.coins) : (o.balance ? fmtCoins(o.balance.coins) : '—')}
          hint={o.coinTotal ? `на ${o.coinTotal.wallets} кошельках пользователей` : undefined}
        />
      </div>

      {/* Подписка («что оплачено») намеренно НЕ здесь: это личная покупка клиента, а
          не системная метрика админа. Она живёт в «Мои модули» у самого пользователя. */}

      <div className="grid gap-3 lg:grid-cols-2">
        <Breakdown title="Аккаунты по статусам" data={o.accounts.byStatus} ru />
        <Breakdown title="Задачи по статусам" data={o.tasks.byStatus} ru />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Breakdown title="Токены по модулям" data={o.tokens.byModule} />
        <Breakdown title="Действия в журнале" data={o.audit.byAction} />
      </div>

      <Card className="p-4">
        <div className="text-sm text-muted">
          Пользователей в системе: <b className="text-fg">{o.users.total}</b> ({o.users.active} активных).
          Записей в журнале за период: <b className="text-fg">{fmt(o.audit.total)}</b>.
        </div>
      </Card>
    </div>
  )
}

/**
 * Постатейный отчёт «по проекту» ИЛИ по конкретному клиенту (клиентов может быть
 * больше одного). Селектор сверху: «Весь проект» или выбранный клиент — тогда отчёт
 * перезапрашивается по нему. CSV выгружает то, что показано.
 */
function ReportTab({ report, onExport, users, since }: { report: ClientReport | null; onExport: (rep: ClientReport | null) => void; users: UserRow[]; since: number }) {
  const [client, setClient] = useState('')
  const [override, setOverride] = useState<ClientReport | null>(null)
  const [loading, setLoading] = useState(false)

  const clients = users.filter((u) => u.userId && !u.email.startsWith('без владельца') && !u.email.startsWith('удалённый'))

  useEffect(() => {
    if (!client) { setOverride(null); return }
    let alive = true
    setLoading(true)
    fetchClientReport(since || undefined, client)
      .then((r) => { if (alive) setOverride(r) })
      .catch(() => { if (alive) setOverride(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, since])

  const shown = client ? override : report
  const clientName = client ? (clients.find((c) => c.userId === client)?.name || clients.find((c) => c.userId === client)?.email || 'клиент') : ''

  const selector = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">Клиент:</span>
      <select value={client} onChange={(e) => setClient(e.target.value)} className="input h-9 w-auto text-sm">
        <option value="">Весь проект</option>
        {clients.map((c) => <option key={c.userId} value={c.userId}>{c.name || c.email}</option>)}
      </select>
      <button onClick={() => onExport(shown)} disabled={!shown?.rows.length} className="btn-ghost ml-auto h-9 text-sm disabled:opacity-40"><Download size={15} /> Выгрузить CSV</button>
    </div>
  )

  if (loading && client) {
    return <Card className="p-4">{selector}<div className="px-1 py-4 text-sm text-muted">Загрузка…</div></Card>
  }
  if (!shown || !shown.rows.length) {
    return (
      <Card className="p-4">
        {selector}
        <EmptyState icon={<BarChart3 size={22} />} title="За период работ не было" desc={client ? `У «${clientName}» нет работ за период.` : 'Выберите другой период — отчёт строится по задачам модулей.'} />
      </Card>
    )
  }
  return (
    <Card className="p-4">
      {selector}
      <div className="mb-1 text-sm font-semibold text-fg">
        Отчёт {client ? `по клиенту «${clientName}»` : 'по проекту'} за {fmtDate(shown.since)} — {fmtDate(shown.until)}
      </div>
      <p className="mb-3 text-xs text-muted">
        Постатейно: строка на модуль. Детали отдельных действий — в логах задач, здесь только итоги.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="pb-2 pr-3 font-medium">Модуль</th>
              <th className="pb-2 pr-3 text-right font-medium">Задач</th>
              <th className="pb-2 pr-3 text-right font-medium">Завершено</th>
              <th className="pb-2 pr-3 text-right font-medium">Действий</th>
              <th className="pb-2 pr-3 text-right font-medium">Токенов</th>
              <th className="pb-2 text-right font-medium">Монет</th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.map((r) => (
              <tr key={r.moduleKey} className="border-b border-line/50">
                <td className="py-2 pr-3 text-fg">{r.title}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tasks)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.completed)}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-fg">{fmt(r.actions)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tokens)}</td>
                <td
                  className="py-2 text-right tabular-nums text-amber-300"
                  title={`За действия ${fmtCoins(r.actionCoins ?? 0)} + за ИИ ${fmtCoins(r.tokenCoins ?? 0)}`}
                >{r.coins ? fmtCoins(r.coins) : '—'}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-2 pr-3 text-fg">ИТОГО</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(shown.totals.tasks)}</td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(shown.totals.actions)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(shown.totals.tokens)}</td>
              <td
                className="py-2 text-right tabular-nums text-amber-300"
                title={`За действия ${fmtCoins(shown.totals.actionCoins ?? 0)} + за ИИ ${fmtCoins(shown.totals.tokenCoins ?? 0)}`}
              >{shown.totals.coins ? fmtCoins(shown.totals.coins) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * §5.3 «трекинг пользователей»: кто, что делал, сколько потратил и КУДА.
 *
 * Отключить человека можно прямо отсюда: админ смотрит статистику и тут же видит,
 * кого пора закрыть, — уходить за этим на другую страницу значит терять контекст.
 * Строка раскрывается в разрез по модулям: «потратил 5 000 токенов» без «на что»
 * не отвечает ни на один реальный вопрос.
 */
function UsersTab({ report, onReload }: { report: UsersReport | null; onReload: () => void }) {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // §10.4: каталог модулей + черновик доступа по юзеру — админ включает/выключает
  // модули конкретному человеку, не уходя со страницы.
  const [catalog, setCatalog] = useState<{ key: string; title: string }[]>([])
  const [modDraft, setModDraft] = useState<Record<string, string[] | 'all'>>({})
  // §10.4: доступные роли — чтобы назначать роль юзеру прямо из админки (раз редактор
  // ролей теперь здесь же, логично и раздавать их отсюда).
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([])
  // §10.4: пополнения кошелька по человеку (что купил из токенов/монет) — тянем лениво
  // при раскрытии карточки. 'loading' пока грузится, массив — только пополнения (amount>0).
  const [topups, setTopups] = useState<Record<string, WalletEntry[] | 'loading'>>({})
  // §11.1: журнал активности — тянем лениво при раскрытии карточки. Это ответственность
  // за то, что делают чужие люди внутри нашей системы, поэтому лежит рядом с юзером.
  const [activity, setActivity] = useState<Record<string, UserActivity | 'loading'>>({})
  // §11.1: «с кем переписывается» — диалоги аккаунтов этого юзера.
  const [dialogs, setDialogs] = useState<Record<string, UserDialogs | 'loading'>>({})
  useEffect(() => {
    void fetchSubscription().then((d) => setCatalog(d.items.map((i) => ({ key: i.key, title: i.title })))).catch(() => {})
    void fetchRoles().then((rs) => setRoles(rs.map((r) => ({ id: r.id, name: r.name })))).catch(() => {})
  }, [])

  const openUser = (r: UserRow) => {
    const willOpen = open !== r.userId
    setOpen(willOpen ? r.userId : null)
    // При КАЖДОМ открытии переинициализируем черновик доступа из серверной правды.
    // Иначе брошенный (несохранённый) черновик прошлого открытия переживал reload и мог
    // перетереть текущий доступ при «Применить»: показывал устаревшие галочки как реальные.
    if (willOpen) {
      setModDraft((d) => ({ ...d, [r.userId]: r.subscription?.all ? 'all' : (r.subscription?.keys ?? []) }))
      // Пополнения кошелька этого юзера — грузим один раз на открытие (что он покупал).
      if (topups[r.userId] === undefined) {
        setTopups((t) => ({ ...t, [r.userId]: 'loading' }))
        void fetchWalletHistory(50, r.userId)
          .then((rows) => setTopups((t) => ({ ...t, [r.userId]: rows.filter((e) => e.amount > 0) })))
          .catch(() => setTopups((t) => ({ ...t, [r.userId]: [] })))
      }
      // §11.1: журнал активности этого юзера (аудит по нему и над ним).
      if (dialogs[r.userId] === undefined) {
        setDialogs((d) => ({ ...d, [r.userId]: 'loading' }))
        void fetchUserDialogs(r.userId)
          .then((x) => setDialogs((d) => ({ ...d, [r.userId]: x })))
          .catch(() => setDialogs((d) => ({ ...d, [r.userId]: { userId: r.userId, rows: [], total: 0, accounts: 0 } })))
      }
      if (activity[r.userId] === undefined) {
        setActivity((a) => ({ ...a, [r.userId]: 'loading' }))
        void fetchUserActivity(r.userId)
          .then((act) => setActivity((a) => ({ ...a, [r.userId]: act })))
          .catch(() => setActivity((a) => ({ ...a, [r.userId]: { userId: r.userId, email: '', total: 0, rows: [], actions: [] } })))
      }
    }
  }
  const toggleUserMod = (userId: string, key: string) => setModDraft((d) => {
    const cur = d[userId] === 'all' ? catalog.map((c) => c.key) : [...(d[userId] as string[] || [])]
    const i = cur.indexOf(key)
    if (i >= 0) cur.splice(i, 1); else cur.push(key)
    return { ...d, [userId]: cur }
  })
  const setUserAll = (userId: string, all: boolean) => setModDraft((d) => ({ ...d, [userId]: all ? 'all' : [] }))
  const saveUserAccess = async (userId: string, email: string) => {
    setBusy(userId)
    try {
      const mods = modDraft[userId]
      await saveUserModules(userId, mods === 'all' ? 'all' : (mods || []))
      pushToast({ type: 'success', title: 'Доступ обновлён', desc: email })
      onReload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить доступ', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(null) }
  }

  if (!report) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!report.rows.length) return <EmptyState icon={<Users size={22} />} title="Пользователей нет" />

  // §4 (MR-27): ищем по имени, почте И по ID — у каждого юзера уникальный id, и иногда
  // человека адресуют именно по нему (в логах, в поддержке).
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? report.rows.filter((r) => `${r.name} ${r.email} ${r.userId}`.toLowerCase().includes(needle))
    : report.rows

  // §10.4: кластеризация — суб-юзеры СПРЯТАНЫ ВНУТРЬ владельца и раскрываются по клику.
  // Показывать их всегда нельзя: на 10 владельцах по 100 субов список превращается в
  // сплошной шум, и владельцев в нём уже не найти. По умолчанию видны только владельцы,
  // у каждого — счётчик «N суб-юзеров»; поиск раскрывает совпавшие кластеры сам.
  /** Суб-юзеры по владельцу — считаем по ВСЕМ строкам, а не по отфильтрованным. */
  const subsByOwner = useMemo(() => {
    const m = new Map<string, typeof report.rows>()
    for (const r of report.rows) if (r.parentId) { const a = m.get(r.parentId) || []; a.push(r); m.set(r.parentId, a) }
    return m
  }, [report.rows])

  /**
   * Владельцы, а под раскрытым — его субы ОБЫЧНЫМИ строками таблицы.
   *
   * Раньше субы рисовались карточками внутри одной раскрытой строки, и клик по такой
   * карточке ничего не показывал: механика «развернуть все действия юзера» привязана
   * к строке таблицы. Строкой суб получает ровно ту же карточку, что и администратор.
   */
  /** Какие владельцы раскрыты — их субы показываются строкой сразу под ними. */
  const [openSubs, setOpenSubs] = useState<Set<string>>(new Set())
  const toggleSubs = (ownerId: string) => setOpenSubs((prev) => {
    const n = new Set(prev); n.has(ownerId) ? n.delete(ownerId) : n.add(ownerId); return n
  })

  const clustered = useMemo(() => {
    const out: typeof shown = []
    for (const r of shown) {
      if (r.parentId) continue // субы выводим под своим владельцем
      out.push(r)
      if (openSubs.has(r.userId)) out.push(...(subsByOwner.get(r.userId) || []))
    }
    // Субы, чьего владельца нет в выборке (например, отфильтрован поиском) — в конец.
    for (const r of shown) if (r.parentId && !out.some((x) => x.userId === r.userId)) out.push(r)
    return out
  }, [shown, openSubs, subsByOwner])



  /**
   * Пополнение прямо из таблицы: админ видит, у кого кончаются монеты, и тут же
   * доливает — иначе за этим надо уходить в чужой профиль и терять, кому доливал.
   * Отрицательная сумма списывает: та же операция, тот же аудит.
   */
  const topUp = async (userId: string, email: string) => {
    // §11.4: по умолчанию начисляем ДЕНЬГИ ($) — это основной кошелёк. Токены — топливо,
    // их клиент покупает за $; но админу иногда надо выдать их напрямую (тест/бонус),
    // поэтому суффикс ⚡ переключает на токены. Отрицательное число — списать.
    const raw = await promptDialog({
      title: 'Пополнить кошелёк',
      message: `Сколько долларов ($) начислить: ${email}? Для токенов допишите ⚡ (напр. 100⚡). Отрицательное — списать.`,
      placeholder: '10',
    })
    if (raw === null) return
    const s = String(raw).trim().replace(',', '.')
    const isTokens = /⚡|\bт\b|t$/i.test(s)
    const amount = Number(s.replace(/[^0-9.\-]/g, ''))
    if (!Number.isFinite(amount) || !amount) {
      pushToast({ type: 'error', title: 'Нужно число', desc: 'Например 10 (это $10) или 100⚡ (токены)' })
      return
    }
    setBusy(userId)
    try {
      if (isTokens) {
        await changeBalance({ amount, reason: 'Выдача токенов из админ-панели', userId })
        pushToast({ type: 'success', title: amount > 0 ? `Начислено ${amount} ⚡` : `Списано ${-amount} ⚡`, desc: email })
      } else {
        await changeBalance({ usd: amount, reason: 'Пополнение $ из админ-панели', userId })
        pushToast({ type: 'success', title: amount > 0 ? `Начислено $${amount}` : `Списано $${-amount}`, desc: email })
      }
      onReload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось изменить баланс', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(null) }
  }

  const toggle = async (userId: string, active: boolean) => {
    setBusy(userId)
    try {
      await updateUser(userId, { active: !active })
      pushToast({ type: 'success', title: !active ? 'Пользователь включён' : 'Пользователь отключён' })
      onReload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось изменить', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(null) }
  }

  // §4.1/§5.3 (MR-29): назначение ролей и подчинения субов ПЕРЕЕХАЛО в панель владельца
  // («Команда»). В админке эти действия убраны — остался только просмотр (см. карточку).

  return (
    <>
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="input h-9 pl-9 text-sm"
            placeholder="Поиск по имени, почте или ID…"
          />
        </div>
        <span className="text-xs text-muted">
          Нажмите на строку — откроются <b className="text-fg">все действия</b> юзера: входы, запуски, изменения баланса, ролей и подписки.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="pb-2 pr-3 font-medium">Пользователь</th>
              <th className="pb-2 pr-3 text-right font-medium">Задач</th>
              <th className="pb-2 pr-3 text-right font-medium">Действий</th>
              <th className="pb-2 pr-3 text-right font-medium">Токенов</th>
              <th className="pb-2 pr-3 text-right font-medium">Списано</th>
              <th className="pb-2 pr-3 text-right font-medium">На счету</th>
              <th className="pb-2 pr-3 text-left font-medium">Подписка</th>
              <th className="pb-2 text-right font-medium">Доступ</th>
            </tr>
          </thead>
          <tbody>
            {clustered.map((r) => {
              // Строки без реального пользователя (удалённые, задачи без владельца)
              // отключать нечего — кнопки у них нет, но из счёта они не исчезают.
              const real = !!r.userId && !r.email.startsWith('без владельца') && !r.email.startsWith('удалённый')
              const isOpen = open === r.userId
              return [
                <tr
                  key={r.userId}
                  className={cn('cursor-pointer border-b border-line/50 hover:bg-white/[.02]', r.parentId && 'bg-iris-500/[.03]')}
                  onClick={() => openUser(r)}
                >
                  <td className={cn('py-2 pr-3', r.parentId && 'pl-6')}>
                    <div className="flex items-center gap-1.5">
                      <ChevronDown size={13} className={cn('text-muted transition-transform', isOpen && 'rotate-180')} />
                      {/* Имя — то, чем человека называют. Почта под ним: она нужна,
                          чтобы его найти и написать, но в списке читается хуже. */}
                      <span className="min-w-0">
                        <span className={cn('block truncate text-fg', !r.active && real && 'text-muted line-through')}>
                          {r.name || r.email || r.userId}
                        </span>
                        {!!r.name && !!r.email && <span className="block truncate text-[11px] text-muted">{r.email}</span>}
                        {/* UID — мелким, чтобы можно было сверить/отправить в поддержку. */}
                        {real && <span className="block truncate font-mono text-[10px] text-faint" title="UID пользователя">{r.userId}</span>}
                        {/* §10.4: суб-юзер — показываем, под каким админом он вложен. */}
                        {!!r.parentId && <span className="block truncate text-[11px] text-iris-300">↳ суб-юзер · под {r.parentName || r.parentId}</span>}
                      </span>
                      {/* §10.4: роль(и) юзера — читаемым именем сбоку. */}
                      {real && r.roleName && <span className="shrink-0 rounded-md bg-iris-500/12 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">{r.roleName}</span>}
                      {real && !r.roleName && <span className="shrink-0 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">без роли</span>}
                      {!r.active && real && <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">отключён</span>}
                      {/* Субы раскрываются строкой ПРЯМО ПОД владельцем — как карточка
                          аккаунта. Клик по бейджу не открывает карточку самого владельца. */}
                      {(subsByOwner.get(r.userId)?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleSubs(r.userId) }}
                          title={openSubs.has(r.userId) ? 'Свернуть суб-юзеров' : 'Показать суб-юзеров этого владельца'}
                          className={cn('ml-1 inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold',
                            openSubs.has(r.userId)
                              ? 'border-iris-500/50 bg-iris-500/20 text-iris-200'
                              : 'border-iris-500/30 bg-iris-500/10 text-iris-300 hover:bg-iris-500/20')}
                        >
                          <ChevronDown size={10} className={cn('transition-transform', openSubs.has(r.userId) && 'rotate-180')} />
                          {subsByOwner.get(r.userId)?.length} субов
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tasks)}</td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums text-fg">{fmt(r.actions)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.tokens)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-amber-300">{r.spent ? fmtCoins(r.spent) : '—'}</td>
                  <td className="py-2 pr-3 text-right">
                    {/* §11.4: деньги ($) — ОСНОВНОЕ, сверху; токены ⚡ — топливо, мельче под ними. */}
                    {/* §4.2 (MR-30): суб с ОБЩИМ балансом отдельного кошелька не имеет — тратит из
                        кошелька владельца (getBalance/списания резолвят resolveWalletOwner). Раньше тут
                        показывался «сырой» остаток coin_balance суба — он вводил в заблуждение («$45 у
                        суба», хотя платит владелец). Показываем правду; отдельная сумма и пополнение —
                        только у владельца и у субов с индивидуальным лимитом. */}
                    {r.parentId && r.balanceMode !== 'individual' ? (
                      <span className="block leading-tight">
                        <span className="block text-[11px] font-medium text-iris-300">Общий с владельцем</span>
                        <span className="block text-[10px] text-muted">тратит из кошелька владельца</span>
                      </span>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="leading-tight">
                          <span className="block text-sm font-semibold tabular-nums text-fg">${(r.usd ?? 0).toFixed(2)}</span>
                          <span className="block text-[11px] tabular-nums text-amber-300/80">
                            {fmtCoins(r.coins ?? 0)} ⚡{r.parentId ? <span className="ml-1 text-iris-300/80">· лимит</span> : null}
                          </span>
                        </span>
                        {real && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void topUp(r.userId, r.email) }}
                            disabled={busy === r.userId}
                            className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line text-muted transition-colors hover:border-spark-500/40 hover:text-spark-300 disabled:opacity-40"
                            title="Пополнить $ / выдать токены"
                          >
                            <Plus size={13} />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {r.subscription
                      ? (r.subscription.all
                          ? <span className="text-xs text-muted" title="Набор не выбран — открыто всё">Все модули</span>
                          : r.subscription.count
                            ? <span className="cursor-help text-xs text-fg" title={r.subscription.titles.join(', ')}>{r.subscription.count} мод.</span>
                            : <span className="text-xs text-muted">нет</span>)
                      : <span className="text-xs text-muted">—</span>}
                  </td>
                  <td className="py-2 text-right">
                    {real ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void toggle(r.userId, r.active) }}
                        disabled={busy === r.userId}
                        className={cn('inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-semibold disabled:opacity-40',
                          r.active ? 'border-line text-muted hover:border-red-500/40 hover:text-red-300' : 'border-spark-500/40 text-spark-300')}
                        title={r.active ? 'Отключить доступ' : 'Включить доступ'}
                      >
                        <Power size={12} /> {r.active ? 'Отключить' : 'Включить'}
                      </button>
                    ) : <span className="text-xs text-muted">—</span>}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={r.userId + '-where'} className="border-b border-line/50 bg-white/[.02]">
                    <td colSpan={8} className="px-3 py-3">
                      {real && (
                        <div className="mb-4 rounded-xl border border-line bg-elevated/50 p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Доступ к модулям</span>
                            <span className="text-xs text-muted">· {r.name || r.email}</span>
                            {/* §5.3 (MR-36): один понятный переключатель уровня доступа вместо
                                двух галочек — «Все модули» или «Выбранные» (ниже отмечаем какие). */}
                            <div className="ml-auto">
                              <Segmented size="sm" options={['Все модули', 'Выбранные']}
                                value={modDraft[r.userId] === 'all' ? 0 : 1}
                                onChange={(i) => setUserAll(r.userId, i === 0)} />
                            </div>
                          </div>
                          {modDraft[r.userId] !== 'all' && (
                            <div className="flex flex-wrap gap-1.5">
                              {catalog.map((c) => {
                                const on = (modDraft[r.userId] as string[] || []).includes(c.key)
                                return (
                                  <button key={c.key} onClick={() => toggleUserMod(r.userId, c.key)}
                                    className={cn('rounded-lg border px-2 py-1 text-xs transition-colors',
                                      on ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
                                    {on ? '✓ ' : ''}{c.title}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                          <div className="mt-2.5 flex items-center gap-2">
                            <span className="text-[11px] text-muted">
                              {modDraft[r.userId] === 'all'
                                ? 'Открыты все модули'
                                : (modDraft[r.userId] as string[] || []).length
                                  ? `Выбрано модулей: ${(modDraft[r.userId] as string[]).length}`
                                  : 'Не выбрано ни одного модуля — доступа к модулям нет'}
                            </span>
                            <button onClick={() => void saveUserAccess(r.userId, r.email)} disabled={busy === r.userId}
                              className="btn-primary ml-auto h-8 text-xs disabled:opacity-40">
                              {busy === r.userId ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Применить доступ
                            </button>
                          </div>
                        </div>
                      )}
                      {/* §4.1/§5.3 (MR-29): роли и подчинение субпользователей настраивает
                          ВЛАДЕЛЕЦ в своей панели «Команда». В общей админке — только просмотр:
                          назначение ролей клиента и распределение субов отсюда убрано. */}
                      {real && (
                        <div className="mb-4 grid gap-3 rounded-xl border border-line bg-elevated/50 p-3">
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">Роли</div>
                            {(r.roleIds || []).length
                              ? <div className="flex flex-wrap gap-1">
                                  {(r.roleIds || []).map((id) => (
                                    <span key={id} className="rounded-md bg-iris-500/10 px-1.5 py-0.5 text-[11px] text-iris-200">{roles.find((x) => x.id === id)?.name || id}</span>
                                  ))}
                                </div>
                              : <span className="text-xs text-muted">Ролей нет</span>}
                            <div className="mt-1.5 text-[10px] text-faint">Настраивается в панели владельца → «Команда».</div>
                          </div>
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">Подчинение</div>
                            {r.parentId
                              ? <span className="text-xs text-fg">Суб-юзер под: {report.rows.find((u) => u.userId === r.parentId)?.name || report.rows.find((u) => u.userId === r.parentId)?.email || r.parentId}</span>
                              : <span className="text-xs text-muted">Самостоятельный владелец</span>}
                          </div>
                        </div>
                      )}
                      {/* §11.9: последний вход и IP — админ должен видеть, откуда заходят
                          (сценарий со звонка: доступ забрал уволенный сотрудник). Блокировка —
                          кнопка «Отключить» справа в строке: она закрывает и вход, и сессию. */}
                      {real && (
                        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-elevated/50 p-3 text-xs">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Последний вход</span>
                          {r.lastLogin ? (
                            <>
                              <span className="text-fg">{new Date(r.lastLogin.at).toLocaleString('ru-RU')}</span>
                              {r.lastLogin.ip
                                ? <span className="rounded-md bg-white/8 px-1.5 py-0.5 font-mono text-[11px] text-muted">IP {r.lastLogin.ip}</span>
                                : <span className="text-faint">IP не записан</span>}
                            </>
                          ) : <span className="text-muted">входов в журнале нет</span>}
                        </div>
                      )}
                      {/* §11.1 (кол 29.07): ВСЕ действия юзера — подняты вверх карточки, сразу
                          под входом. Это то, «где видеть всё, что человек делал»: раньше журнал
                          был в самом низу и его не находили. */}
                      {real && <UserActivityLog state={activity[r.userId]} />}
                      {/* §10.4: что человек КУПИЛ — модули (подписка) и пополнения кошелька.
                          Отдельно от «что запускал»: одно отвечает «за что платил», другое «что делал». */}
                      {real && (
                        <div className="mb-4 grid gap-4 rounded-xl border border-line bg-elevated/50 p-3">
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">Купленные модули</div>
                            {r.subscription?.all
                              ? <span className="text-xs text-spark-300">Все модули (полный доступ)</span>
                              : r.subscription?.count
                                ? <div className="flex flex-wrap gap-1">
                                    {r.subscription.titles.map((t) => (
                                      <span key={t} className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-fg">{t}</span>
                                    ))}
                                  </div>
                                : <span className="text-xs text-muted">Ничего не куплено</span>}
                          </div>
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">Пополнения (монеты)</div>
                            {topups[r.userId] === 'loading'
                              ? <span className="text-xs text-muted">Загрузка…</span>
                              : (topups[r.userId] as WalletEntry[] | undefined)?.length
                                ? <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                                    {(topups[r.userId] as WalletEntry[]).map((e, i) => (
                                      <div key={i} className="flex items-baseline justify-between gap-2 border-b border-line/30 pb-1 text-xs last:border-0">
                                        <span className="tabular-nums text-spark-300">+{fmtCoins(e.amount)} ⚡</span>
                                        {usdEq(e.amount, report.coinUsd) && <span className="text-[10px] text-muted">{usdEq(e.amount, report.coinUsd)}</span>}
                                        <span className="ml-auto shrink-0 tabular-nums text-faint">{new Date(e.ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                                      </div>
                                    ))}
                                  </div>
                                : <span className="text-xs text-muted">Пополнений не было</span>}
                          </div>
                        </div>
                      )}
                      {!r.where.length && !r.log.length ? (
                        <span className="text-xs text-muted">За выбранный период ничего не запускал.</span>
                      ) : (
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">Куда уходила работа</div>
                            <div className="space-y-1">
                              {r.where.map((w) => (
                                <div key={w.moduleKey} className="flex items-baseline justify-between gap-3 text-xs">
                                  <span className="text-muted">{w.title}</span>
                                  <span className="tabular-nums text-fg">
                                    {fmt(w.actions)} действий
                                    {w.tokens ? <span className="text-muted"> · {fmt(w.tokens)} ток.</span> : null}
                                    {w.spent ? <span className="text-amber-300"> · {fmtCoins(w.spent)} ⚡</span> : null}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Сами запуски с датами: «потратил 0.15 за месяц» не отвечает
                              на «что он делал в среду» — а разбирают счёт именно так. */}
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                              Что запускал ({r.log.length}{r.log.length >= 100 ? ', показаны последние 100' : ''})
                            </div>
                            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                              {r.log.map((t) => (
                                <div key={t.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/30 pb-1 text-xs last:border-0">
                                  <span className="text-fg">{t.title}</span>
                                  <span className={cn('rounded px-1 text-[10px] font-bold',
                                    t.status === 'done' ? 'bg-spark-500/12 text-spark-300'
                                      : t.status === 'paused' ? 'bg-amber-500/12 text-amber-300'
                                      : 'bg-white/8 text-muted')}>{t.status}</span>
                                  {!!t.errors && <span className="rounded bg-red-500/12 px-1 text-[10px] font-bold text-red-300">{t.errors} ош.</span>}
                                  <span className="text-muted">{fmt(t.actions)} действий</span>
                                  {!!t.spent && <span className="text-amber-300">{fmtCoins(t.spent)} ⚡</span>}
                                  <span className="ml-auto shrink-0 tabular-nums text-faint">
                                    {t.at ? new Date(t.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* §11.1: с кем переписывается — оставляем ниже, это отдельный разрез. */}
                      {real && <UserDialogsBlock state={dialogs[r.userId]} />}
                    </td>
                  </tr>
                ) : null,
              ]
            })}
            <tr className="font-semibold">
              <td className="py-2 pr-3 text-fg">ИТОГО</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tasks)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.actions)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fg">{fmt(report.totals.tokens)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-300">{fmtCoins(report.totals.spent)}</td>
              <td className="py-2 pr-3 text-right leading-tight">
                <span className="block text-sm tabular-nums text-fg">${(report.totals.usd ?? 0).toFixed(2)}</span>
                <span className="block text-[11px] tabular-nums text-amber-300/80">{fmtCoins(report.totals.coins)} ⚡</span>
              </td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Card>

    </>
  )
}

/** Статус лида читаемо — админ разбирает переписку, а не коды. */
const LEAD_STATUS_RU: Record<string, string> = {
  cold: 'холодный', contacted: 'написали', replied: 'ответил', warm: 'тёплый',
  target: 'целевой', refused: 'отказ', lost: 'потерян',
}

/**
 * §11.1: «с кем переписывается» — диалоги аккаунтов юзера.
 *
 * Текстов сообщений тут нет намеренно: их хранение — открытый вопрос (приватность и
 * объём). Показываем «кто, каким аккаунтом, в каком статусе и когда» — этого хватает,
 * чтобы увидеть, с кем идёт работа, и не заводя нового хранилища.
 */
function UserDialogsBlock({ state }: { state: UserDialogs | 'loading' | undefined }) {
  // §11.1: какой диалог раскрыт и его реплики. Тянем по клику — переписка тяжелее
  // списка, грузить её на все диалоги сразу незачем.
  const [open, setOpen] = useState('')
  const [chat, setChat] = useState<MessageRow[] | 'loading' | null>(null)
  const toggle = (d: { peer: string; accountId: string }) => {
    if (open === d.peer) { setOpen(''); setChat(null); return }
    setOpen(d.peer)
    setChat('loading')
    void fetchMessages({ peer: d.peer, accountId: d.accountId, limit: 200 })
      .then((rows) => setChat([...rows].reverse())) // в чате читают снизу вверх: старые сначала
      .catch(() => setChat([]))
  }
  if (state === undefined) return null
  if (state === 'loading') return <div className="mt-4 text-xs text-muted">Диалоги загружаются…</div>
  if (!state.rows.length) {
    return (
      <div className="mt-4 rounded-xl border border-line bg-elevated/50 p-3 text-xs text-muted">
        <span className="font-bold uppercase tracking-wide">С кем переписывается</span>
        <span className="ml-2">диалогов не найдено{state.accounts ? ` (аккаунтов в его задачах: ${state.accounts})` : ''}.</span>
      </div>
    )
  }
  return (
    <div className="mt-4 rounded-xl border border-line bg-elevated/50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
          С кем переписывается ({state.total}{state.total > state.rows.length ? `, показаны ${state.rows.length}` : ''})
        </span>
        <span className="text-[10px] text-faint">аккаунтов задействовано: {state.accounts}</span>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
        {state.rows.map((d) => (
          <div key={d.id} className="border-b border-line/30 pb-1 last:border-0">
          <button onClick={() => toggle(d)} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left text-xs">
            <span className="font-medium text-fg underline decoration-dotted underline-offset-2">{d.peer || '—'}</span>
            {d.isHot && <span className="rounded bg-red-500/12 px-1 text-[10px] font-bold text-red-300">горячий</span>}
            <span className="text-muted">{LEAD_STATUS_RU[d.status] || d.status}</span>
            <span className="text-[10px] text-faint">через {d.accountName}</span>
            {!d.viaOwner && (
              <span className="rounded bg-white/8 px-1 text-[10px] text-muted" title="Связано через аккаунт из его задачи — у самой записи владельца нет">
                по аккаунту
              </span>
            )}
            {!!d.note && <span className="min-w-0 flex-1 truncate text-muted" title={d.note}>{d.note}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-faint">
              {d.at ? new Date(d.at).toLocaleDateString('ru-RU') : '—'}
            </span>
          </button>
          {/* §11.1: сама переписка — раскрывается по клику на собеседнике. */}
          {open === d.peer && (
            <div className="mt-1 space-y-1 rounded-lg border border-line/60 bg-surface/60 p-2">
              {chat === 'loading' && <div className="text-[11px] text-muted">Загрузка переписки…</div>}
              {chat !== 'loading' && !chat?.length && <div className="text-[11px] text-muted">Реплик не сохранено (переписка велась до включения хранения).</div>}
              {chat !== 'loading' && chat?.map((m) => (
                <div key={m.id} className={cn('text-[11px] leading-snug', m.direction === 'out' ? 'text-spark-200' : 'text-fg')}>
                  <span className="mr-1 text-faint">{new Date(m.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="mr-1 font-bold">{m.direction === 'out' ? 'мы →' : '← он'}</span>
                  <span className="whitespace-pre-wrap">{m.text}</span>
                </div>
              ))}
            </div>
          )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Человеческие названия событий аудита — админ читает журнал, а не грепает коды. */
const ACTION_LABEL: Record<string, string> = {
  'user.login': 'Вход', 'user.login.fail': 'Неудачный вход', 'user.logout': 'Выход',
  'user.update': 'Изменён профиль', 'user.create': 'Создан юзер',
  'task.start': 'Запуск задачи', 'task.stop': 'Остановка задачи', 'task.pause': 'Пауза задачи',
  'balance.change': 'Изменение баланса', 'subscription.set': 'Изменение подписки',
  'role.update': 'Изменение роли', 'prices.update': 'Изменение цен',
  'account.status.change': 'Смена статуса аккаунта', 'account.transfer': 'Перенос аккаунта',
  'apikey.issue': 'Выпущен API-ключ', 'apikey.revoke': 'Отозван API-ключ',
  'bundle.create': 'Создан набор', 'bundle.delete': 'Удалён набор',
}

/**
 * §11.1: журнал активности юзера в его карточке.
 *
 * Показываем и то, что он делал сам, и то, что делали НАД ним (смена баланса/роли
 * админом) — при разборе инцидента важно и то и другое; чужие действия помечаем.
 */
function UserActivityLog({ state }: { state: UserActivity | 'loading' | undefined }) {
  const [filter, setFilter] = useState('')
  if (state === undefined) return null
  if (state === 'loading') return <div className="mt-4 text-xs text-muted">Журнал загружается…</div>

  const rows = filter ? state.rows.filter((r) => r.action === filter) : state.rows
  return (
    <div className="mt-4 rounded-xl border border-spark-500/30 bg-spark-500/[0.04] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-fg">
          <ScrollText size={15} className="text-spark-300" />
          Все действия юзера
          <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[11px] font-bold text-spark-200">{state.total}</span>
          {state.total > state.rows.length && <span className="text-[10px] font-normal text-muted">показаны {state.rows.length}</span>}
        </span>
        {/* Фильтр по типу события — иначе в потоке входов не найти смену баланса. */}
        {state.actions.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setFilter('')}
              className={cn('rounded-md border px-1.5 py-0.5 text-[10px] transition-colors',
                !filter ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
              все
            </button>
            {state.actions.map((a) => (
              <button key={a} onClick={() => setFilter(a === filter ? '' : a)}
                className={cn('rounded-md border px-1.5 py-0.5 text-[10px] transition-colors',
                  filter === a ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
                {ACTION_LABEL[a] || a}
              </button>
            ))}
          </div>
        )}
      </div>

      {!rows.length ? (
        <span className="text-xs text-muted">
          {state.total ? 'По этому фильтру событий нет.' : 'Событий по этому юзеру в журнале нет.'}
        </span>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {rows.map((e, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/30 pb-1 text-xs last:border-0">
              <span className="shrink-0 tabular-nums text-faint">
                {new Date(e.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="font-medium text-fg">{ACTION_LABEL[e.action] || e.action}</span>
              {!e.bySelf && (
                <span className="rounded bg-iris-500/12 px-1 text-[10px] font-bold text-iris-300" title="Действие совершил не он — сделали над ним">
                  над ним
                </span>
              )}
              {!!e.module && <span className="text-[10px] text-muted">{e.module}</span>}
              {!!e.ip && <span className="rounded bg-white/8 px-1 font-mono text-[10px] text-muted">{e.ip}</span>}
              {!!e.reason && <span className="min-w-0 flex-1 truncate text-muted" title={e.reason}>{e.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * §5.3: «что и сколько куплено» — пополнения кошельков по людям.
 *
 * Отдельно от «Пользователей» (там сколько ПОТРАЧЕНО): владельца интересуют обе
 * стороны счёта — сколько человек занёс и сколько сжёг. Списания сюда не идут, это
 * не покупка; здесь только положительные операции — начисления и пополнения.
 */
/**
 * §6 (MR-40b): управление сессией каталог-парсера ИЗ АДМИНКИ. Раньше cookies-сессия
 * настраивалась только внутри модуля «Парсер по каталогу» (её мог трогать любой с
 * доступом к парсеру); это общий системный ресурс, поэтому выносим управление в
 * админ-панель. Переиспользуем готовые API (fetch/upload/verify/clear) — без дубля логики.
 */
function normalizeCookies(text: string): unknown {
  const cleaned = text.replace(/^﻿/, '').trim()
  if (!cleaned) throw new Error('Пусто.')
  let raw: unknown
  try { raw = JSON.parse(cleaned) } catch { throw new Error('Не JSON. Cookie-Editor → Export → JSON.') }
  if (Array.isArray(raw)) return { cookies: raw }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const ss = o.storage_state as { cookies?: unknown } | undefined
    if (ss?.cookies) return ss
    const data = o.data as { cookies?: unknown } | undefined
    if (data?.cookies) return { cookies: data.cookies }
    if (Array.isArray(o.cookies)) return { cookies: o.cookies }
  }
  throw new Error('В файле нет cookies.')
}

function AdminParserSessionTab() {
  const pushToast = useApp((s) => s.pushToast)
  const [session, setSession] = useState<TgstatSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState<'' | 'upload' | 'verify' | 'clear'>('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setSession(await fetchTgstatSession()) } catch { /* нет */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const upload = async () => {
    if (!paste.trim()) return pushToast({ type: 'error', title: 'Вставьте JSON cookies' })
    setBusy('upload')
    try {
      const s = await uploadTgstatSession(normalizeCookies(paste))
      setSession(s)
      const res = await verifyTgstatSession()
      pushToast({ type: res.ok ? 'success' : 'error', title: res.ok ? 'Сессия работает' : 'Проверка не пройдена', desc: res.message })
      setPaste(''); await load()
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка загрузки', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy('') }
  }
  const verify = async () => {
    setBusy('verify')
    try { const res = await verifyTgstatSession(); pushToast({ type: res.ok ? 'success' : 'error', title: res.ok ? 'Сессия работает' : 'Не пройдена', desc: res.message }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) } finally { setBusy('') }
  }
  const clear = async () => {
    setBusy('clear')
    try { setSession(await clearTgstatSession()); pushToast({ type: 'info', title: 'Сессия каталога удалена' }) }
    catch { pushToast({ type: 'error', title: 'Не удалось удалить' }) } finally { setBusy('') }
  }

  const ready = session?.has_session && session.status === 'active' && Boolean(session.last_verified_at)

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Radar size={16} className="text-spark-400" />
          <span className="font-display text-base font-bold text-fg">Сессия каталог-парсера</span>
          {loading ? <Loader2 size={14} className="animate-spin text-muted" />
            : ready ? <Badge tone="spark"><Check size={12} /> Подключена</Badge>
              : <Badge tone="amber"><AlertTriangle size={12} /> Не подключена</Badge>}
          <button onClick={() => void load()} className="btn-ghost ml-auto h-8 text-xs"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Обновить</button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Общая cookies-сессия каталога (массовый парсинг по категориям). Управляется здесь как системный
          ресурс — раньше её настраивали только внутри модуля. Cookies берутся с сайта каталога (Cookie-Editor → Export → JSON).
        </p>
        {session && (
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <MetricTile label="Статус" value={session.status === 'active' ? 'Активна' : session.status === 'error' ? 'Ошибка' : session.status === 'expired' ? 'Истекла' : 'Нет'} tone={ready ? 'text-spark-300' : 'text-amber-300'} sub={session.telegram_logged_in ? 'Telegram в каталоге ✓' : 'Без входа — лимит ~100'} />
            <MetricTile label="Cookies" value={fmt(session.cookie_count || 0)} sub={session.cookie_summary || '—'} />
            <MetricTile label="Проверена" value={session.last_verified_at ? new Date(session.last_verified_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'} sub={session.error_msg || ''} />
          </div>
        )}
        <label className="label">Вставить cookies (JSON)</label>
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} className="input resize-none font-mono text-xs" placeholder='[{"name":"...","value":"...","domain":".tgstat.com"}, …]' />
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => void upload()} disabled={busy !== '' || !paste.trim()} className="btn-primary h-10 disabled:opacity-50">{busy === 'upload' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Загрузить и проверить</button>
          <button onClick={() => void verify()} disabled={busy !== '' || !session?.has_session} className="btn-soft h-10 disabled:opacity-50">{busy === 'verify' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Проверить</button>
          <button onClick={() => void clear()} disabled={busy !== '' || !session?.has_session} className="btn-danger ml-auto h-10 disabled:opacity-50">{busy === 'clear' ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Удалить</button>
        </div>
      </Card>
    </div>
  )
}

/**
 * §8 (MR-44): тикеты поддержки в админке — раньше обращения были моком в браузере и
 * поддержка их не видела. Теперь тянем все тикеты с сервера, отвечаем как «поддержка»
 * и двигаем статус. Самодостаточная вкладка (грузит свои данные, вне общего снапшота).
 */
const TICKET_STATUS_META: Record<TicketStatus, { label: string; tone: 'spark' | 'iris' | 'amber' | 'rose' | 'muted' }> = {
  open: { label: 'Открыт', tone: 'spark' },
  progress: { label: 'В работе', tone: 'iris' },
  waiting: { label: 'Ожидает ответа', tone: 'amber' },
  escalated: { label: 'Эскалирован', tone: 'rose' },
  closed: { label: 'Закрыт', tone: 'muted' },
}
const TICKET_STATUS_OPTS = (Object.keys(TICKET_STATUS_META) as TicketStatus[]).map((v) => ({ value: v, label: TICKET_STATUS_META[v].label }))
const ticketTs = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

function AdminTicketsTab({ autoRefresh = true, registerReload }: {
  autoRefresh?: boolean
  /** Отдаём наверх тихую перезагрузку — её зовёт общий цикл автообновления админки. */
  registerReload?: (fn: (() => Promise<void>) | null) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [tickets, setTickets] = useState<ApiTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [open, setOpen] = useState<ApiTicket | null>(null)
  /** Выбранный КЛИЕНТ: провалились в человека — снизу все его обращения. */
  const [client, setClient] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  // silent — фоновое обновление: не гасим список «Загрузкой», иначе на каждом тике
  // экран моргал бы заглушкой поверх переписки.
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try { setTickets(await fetchTickets(true)) } catch { /* пусто */ } finally { if (!opts?.silent) setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    registerReload?.(() => load({ silent: true }))
    return () => registerReload?.(null)
  }, [registerReload, load])

  const rows = statusFilter === 'all' ? tickets : tickets.filter((t) => t.status === statusFilter)

  /**
   * Кластеры по клиенту: один человек может завести десяток обращений, и плоским
   * списком это каша. Сначала показываем людей (с суммой непрочитанного), а внутри —
   * его тикеты.
   */
  const clients = useMemo(() => {
    const map = new Map<string, { userId: string; label: string; tickets: ApiTicket[]; unread: number; updatedAt: number }>()
    for (const t of rows) {
      const key = t.userId || '—'
      const cur = map.get(key) || { userId: key, label: t.ownerEmail || t.ownerName || key, tickets: [], unread: 0, updatedAt: 0 }
      cur.tickets.push(t)
      cur.unread += t.unread || 0
      cur.updatedAt = Math.max(cur.updatedAt, t.updatedAt || 0)
      map.set(key, cur)
    }
    // Сначала те, у кого есть непрочитанное, потом по свежести.
    return [...map.values()].sort((a, b) => (b.unread - a.unread) || (b.updatedAt - a.updatedAt))
  }, [rows])
  const clientRows = useMemo(() => clients.find((c) => c.userId === client)?.tickets || [], [clients, client])

  // Открытие как поддержка: GET отмечает прочитанным для стороны поддержки → гасим значок.
  const openThread = async (t: ApiTicket) => {
    setOpen(t); setReply('')
    try { const fresh = await fetchTicket(t.id, true); setOpen(fresh); setTickets((l) => l.map((x) => x.id === fresh.id ? { ...fresh, unread: 0 } : x)) } catch { /* keep */ }
  }
  /** Проваливаемся в клиента. Если обращение одно — сразу открываем его. */
  const openClient = (c: { userId: string; tickets: ApiTicket[] }) => {
    setClient(c.userId)
    if (c.tickets.length === 1) void openThread(c.tickets[0])
    else setOpen(null)
  }

  // Живой диалог: пока чат открыт — подтягиваем новые сообщения клиента (как в мессенджере).
  const openId = open?.id
  useEffect(() => {
    if (!openId || !autoRefresh) return
    const iv = setInterval(() => {
      void fetchTicket(openId, true)
        .then((fresh) => {
          setOpen((cur) => (cur && cur.id === fresh.id ? fresh : cur))
          setTickets((l) => l.map((x) => x.id === fresh.id ? { ...fresh, unread: 0 } : x))
        })
        .catch(() => { /* сеть моргнула */ })
    }, 5000)
    return () => clearInterval(iv)
  }, [openId, autoRefresh])

  const feedRef = useRef<HTMLDivElement>(null)
  const msgCount = open?.messages.length ?? 0
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [msgCount, openId])

  const send = async () => {
    if (!open || !reply.trim()) return
    setBusy(true)
    try {
      const upd = await replyTicket(open.id, reply.trim(), true)
      setOpen(upd); setReply(''); setTickets((l) => l.map((x) => x.id === upd.id ? { ...upd, unread: 0 } : x))
    } catch (e) { pushToast({ type: 'error', title: 'Не отправлено', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy(false) }
  }
  const changeStatus = async (status: string) => {
    if (!open) return
    try {
      const upd = await setTicketStatus(open.id, status as TicketStatus)
      setOpen(upd); setTickets((l) => l.map((x) => x.id === upd.id ? upd : x))
      pushToast({ type: 'success', title: 'Статус обновлён' })
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось', desc: e instanceof Error ? e.message : '' }) }
  }

  // Мессенджер, а не «провал внутрь»: слева список диалогов, справа переписка. Так видно
  // очередь обращений и ответ пишется, не теряя контекст (правка заказчика 12.08).
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-52" value={statusFilter} onChange={setStatusFilter} options={[{ value: 'all', label: 'Все статусы' }, ...TICKET_STATUS_OPTS]} />
        <span className="text-sm text-muted">Клиентов: {clients.length} · обращений: {rows.length}</span>
        <button onClick={() => void load()} className="btn-ghost ml-auto h-9" disabled={loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Обновить</button>
      </div>

      {loading ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> Загрузка тикетов…</Card>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<LifeBuoy size={24} />} title="Тикетов нет" desc="Обращения клиентов появятся здесь." /></Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,340px)_1fr]">
          {/* Слева — КЛИЕНТЫ (кластер обращений), внутри клиента — его тикеты.
              На узком экране панель прячется, когда открыт чат. */}
          <Card className={cn('h-[calc(100vh-22rem)] min-h-[320px] overflow-y-auto p-1.5', open && 'hidden lg:block')}>
            {!client ? (
              clients.map((c) => (
                <button
                  key={c.userId}
                  onClick={() => openClient(c)}
                  className="flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition-colors hover:bg-elevated"
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-elevated text-muted"><Users size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('min-w-0 flex-1 truncate text-sm', c.unread ? 'font-bold text-fg' : 'font-semibold text-fg')}>{c.label}</span>
                      {!!c.unread && <span className="grid min-w-[18px] shrink-0 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{c.unread}</span>}
                    </div>
                    <div className="truncate font-mono text-[10px] text-faint">ID {shortId(c.userId)}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <MessageSquare size={11} /> обращений: {c.tickets.length}
                      <span className="text-[10px]">· {ticketTs(c.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <>
                {/* Провалились в человека: шапка с ним + ВСЕ его обращения ниже. */}
                <div className="mb-1 flex items-center gap-2 border-b border-line px-1.5 pb-2">
                  <button onClick={() => { setClient(null); setOpen(null) }} className="btn-ghost h-8 px-2"><ArrowLeft size={15} /></button>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-fg">{clients.find((c) => c.userId === client)?.label || client}</div>
                    <div className="truncate font-mono text-[10px] text-faint">ID {shortId(client)} · обращений: {clientRows.length}</div>
                  </div>
                </div>
                {clientRows.map((t) => {
                  const m = TICKET_STATUS_META[t.status]
                  const last = t.messages[t.messages.length - 1]
                  const active = open?.id === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => void openThread(t)}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition-colors',
                        active ? 'bg-spark-500/12' : 'hover:bg-elevated',
                      )}
                    >
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-elevated text-muted"><MessageSquare size={16} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('min-w-0 flex-1 truncate text-sm', t.unread ? 'font-bold text-fg' : 'font-semibold text-fg')}>{t.subject}</span>
                          {!!t.unread && <span className="grid min-w-[18px] shrink-0 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{t.unread}</span>}
                        </div>
                        <div className={cn('truncate text-[11px]', t.unread ? 'font-semibold text-rose-300' : 'text-muted')}>
                          {last ? `${last.from === 'support' ? 'Поддержка: ' : ''}${last.text}` : '—'}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <Badge tone={m.tone}>{m.label}</Badge>
                          <span className="text-[10px] text-muted">{ticketTs(t.updatedAt)}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </Card>

          {/* Переписка. */}
          <Card className={cn('flex h-[calc(100vh-22rem)] min-h-[320px] flex-col overflow-hidden p-0', !open && 'hidden lg:flex')}>
            {!open ? (
              <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted">
                <div>
                  <MessageSquare size={26} className="mx-auto mb-2 opacity-40" />
                  {client ? 'Выберите обращение клиента слева.' : 'Выберите клиента слева — его обращения и переписка откроются здесь.'}
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
                  <button onClick={() => setOpen(null)} className="btn-ghost h-8 px-2 lg:hidden"><ArrowLeft size={15} /></button>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-fg">{open.subject}</div>
                    <div className="truncate text-[11px] text-muted">{open.id} · клиент {open.ownerEmail || open.ownerName || open.userId} · ID {shortId(open.userId)}</div>
                  </div>
                  <Select className="ml-auto w-44" value={open.status} onChange={(v) => void changeStatus(v)} options={TICKET_STATUS_OPTS} />
                </div>
                <div ref={feedRef} className="flex-1 overflow-y-auto bg-surface/40 px-3 py-3">
                  <TicketChat ticket={open} viewerIsSupport={true} />
                </div>
                <div className="flex gap-2 border-t border-line p-2.5">
                  <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} className="input flex-1" placeholder="Ответ поддержки…" />
                  <button onClick={() => void send()} disabled={busy || !reply.trim()} className="btn-primary h-[42px] px-4 disabled:opacity-50">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

/**
 * §3.3 (MR-23): экономика — доходы, расходы (себестоимость ИИ), маржа и разрез по
 * серверам. Все цифры с сервера (economyReport), пересчитаны по факт-статистике за
 * выбранный период — не по «плановому» прайсу.
 */
function EconRow({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      </span>
      <span className={cn('shrink-0 font-semibold tabular-nums', tone || 'text-fg')}>{value}</span>
    </div>
  )
}

function EconomyTab({ economy }: { economy: Economy | null }) {
  if (!economy) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const e = economy
  // Деньги — суммы в $ с двумя знаками (для крошечной себестоимости токена берём fmtUsd).
  const money = (n: number) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const marginOk = e.margin >= 0

  return (
    <div className="space-y-4">
      {/* Итоги: доход / расход / маржа */}
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="Доходы (валовый приток)" value={money(e.income.total)} tone="text-spark-300"
          sub={`подписки ${money(e.income.plans)} · токены ${money(e.income.tokens)} · пополнения ${money(e.income.balanceTopups)}`} />
        <MetricTile label="Расходы (себестоимость ИИ)" value={money(e.expenses.total)} tone="text-amber-300"
          sub={`${fmt(e.expenses.tokensSpent)} токенов по факту`} />
        <MetricTile label="Маржа" value={money(e.margin)} tone={marginOk ? 'text-spark-300' : 'text-red-400'}
          sub={`${e.marginPct}% от дохода`} />
      </div>

      {/* Доходы — разбивка */}
      <Card className="p-4">
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Доходы за период</div>
        <div className="space-y-2 text-sm">
          <EconRow label="Подписки (планы)" value={money(e.income.plans)} hint={`${fmt(e.income.plansCount)} оплат`} />
          <EconRow label="Продажа токенов" value={money(e.income.tokens)} hint={`${fmt(e.income.tokensCoins)} ⚡ · курс $${fmtUsd(e.income.coinUsd)}/⚡ · ${fmt(e.income.tokensCount)} пополнений`} />
          <EconRow label="Пополнения баланса" value={money(e.income.balanceTopups)} hint={`${fmt(e.income.balanceCount)} операций`} />
          <div className="flex items-center justify-between border-t border-line pt-2">
            <span className="font-semibold text-fg">Итого приток</span>
            <span className="font-semibold tabular-nums text-spark-300">{money(e.income.total)}</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          В демо (без платёжного провайдера) пополнения начисляет админ, и «пополнение баланса» может пересекаться
          с последующей тратой на подписку/токены — поэтому это валовый приток, а не чистая выручка.
        </p>
      </Card>

      {/* Расходы: себестоимость ИИ по модулям */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-bold uppercase tracking-wide text-muted">Расходы: себестоимость ИИ по модулям</div>
          <div className="text-[11px] text-muted">
            себестоимость токена ${fmtUsd(e.expenses.tokenUsd)} {e.expenses.tokenUsdAuto ? `· авто из модели ${e.expenses.tokenUsdModel}` : '· задана вручную'}
          </div>
        </div>
        {e.expenses.byModule.length === 0 ? (
          <div className="text-sm text-muted">За период расход ИИ не зафиксирован.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted">
                  <th className="pb-1 font-semibold">Модуль</th>
                  <th className="pb-1 text-right font-semibold">Токенов</th>
                  <th className="pb-1 text-right font-semibold">Себестоимость</th>
                </tr>
              </thead>
              <tbody>
                {e.expenses.byModule.map((m) => (
                  <tr key={m.key} className="border-t border-line/60">
                    <td className="py-1.5">{m.title}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(m.tokens)}</td>
                    <td className="py-1.5 text-right tabular-nums text-amber-300">{money(m.costUsd)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line font-semibold">
                  <td className="py-1.5">Итого</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(e.expenses.tokensSpent)}</td>
                  <td className="py-1.5 text-right tabular-nums text-amber-300">{money(e.expenses.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Разрез по серверам (ресурсы на кол-во аккаунтов) */}
      <Card className="p-4">
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Ресурсы по серверам</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase text-muted">
                <th className="pb-1 font-semibold">Сервер</th>
                <th className="pb-1 text-right font-semibold">Аккаунтов</th>
                <th className="pb-1 text-right font-semibold">Себестоимость ИИ</th>
                <th className="pb-1 text-right font-semibold">На аккаунт</th>
              </tr>
            </thead>
            <tbody>
              {e.servers.map((s) => (
                <tr key={s.name} className="border-t border-line/60">
                  <td className="py-1.5">{s.name}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(s.accounts)}</td>
                  <td className="py-1.5 text-right tabular-nums text-amber-300">{money(s.aiCostUsd)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(s.costPerAccountUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Пока платформа на одном сервере. Когда добавится мультисервер (MR-65), здесь появится строка на каждый —
          ресурсы на количество аккаунтов.
        </p>
      </Card>
    </div>
  )
}

function PurchasesTab({ p }: { p: Purchases | null }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!p) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>

  const fmtDt = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

  // Что и когда занёс/купил человек: деньги ($), токены (⚡) и планы ($) одной лентой.
  const userOps = (uid: string) => {
    const usd = (p.usd?.feed || []).filter((f) => f.userId === uid).map((f) => ({ ts: f.ts, kind: 'usd' as const, amount: f.amount, label: f.reason || 'пополнение $' }))
    const coins = (p.feed || []).filter((f) => f.userId === uid).map((f) => ({ ts: f.ts, kind: 'coin' as const, amount: f.amount, label: f.reason || 'пополнение токенов' }))
    const pl = (p.plans?.feed || []).filter((f) => f.userId === uid).map((f) => ({ ts: f.ts, kind: 'plan' as const, amount: f.amount, label: f.modulesCount < 0 ? 'все модули' : `${f.modulesCount} мод.` }))
    return [...usd, ...coins, ...pl].sort((a, b) => b.ts - a.ts)
  }

  // §11.4: ОДИН список «кто занёс» — деньги ($) основное, токены (⚡) вторично.
  // Сливаем оба потока по пользователю: кто-то заносил только $, кто-то только токены.
  const brought = (() => {
    const m = new Map<string, { userId: string; name: string; email: string; usd: number; coins: number; count: number; lastAt: number }>()
    for (const r of p.rows) m.set(r.userId, { userId: r.userId, name: r.name, email: r.email, usd: 0, coins: r.coins, count: r.count, lastAt: r.lastAt })
    for (const r of (p.usd?.rows || [])) {
      const e = m.get(r.userId) || { userId: r.userId, name: r.name, email: r.email, usd: 0, coins: 0, count: 0, lastAt: 0 }
      e.usd = r.usd; e.count += r.count; e.lastAt = Math.max(e.lastAt, r.lastAt)
      e.name = e.name || r.name; e.email = e.email || r.email
      m.set(r.userId, e)
    }
    return [...m.values()].sort((a, b) => b.usd - a.usd || b.coins - a.coins)
  })()

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        {/* §11.4: ДЕНЬГИ ($) — основное, первым. Это реальная выручка «занесли на баланс». */}
        <Card className="p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted"><ShoppingCart size={14} /> Пополнено $ за период</div>
          <div className="font-display text-2xl font-bold text-spark-300">${(p.usd?.total ?? 0).toFixed(2)}</div>
          <div className="mt-0.5 text-[11px] text-muted">{fmt(p.usd?.count ?? 0)} операций · {fmt(p.usd?.rows.length ?? 0)} кошельков</div>
        </Card>
        <Card className="p-4">
          <div className="mb-1 text-xs text-muted">Пополнено токенов</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmtCoins(p.boughtTotal)} ⚡</div>
        </Card>
        <Card className="p-4">
          <div className="mb-1 text-xs text-muted">Операций (токены)</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.count)}</div>
        </Card>
        <Card className="p-4">
          <div className="mb-1 text-xs text-muted">Кошельков пополняли</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.rows.length)}</div>
        </Card>
      </div>

      {/* База оплат: любой платёж за любой диапазон дат — «месяц назад» тоже. */}
      <PaymentsExplorer />

      <Card className="p-4">
        <div className="mb-1 text-sm font-semibold text-fg">Кто сколько занёс</div>
        <div className="mb-2 text-xs text-muted">Деньги ($) — основное, токены (⚡) — рядом. Нажмите на пользователя — увидите, что и когда он заносил.</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="pb-2 pr-3 font-medium">Пользователь</th>
                <th className="pb-2 pr-3 text-right font-medium">Пополнений</th>
                <th className="pb-2 pr-3 text-right font-medium">Деньги $</th>
                <th className="pb-2 pr-3 text-right font-medium">Токены ⚡</th>
                <th className="pb-2 text-right font-medium">Последнее</th>
              </tr>
            </thead>
            <tbody>
              {brought.map((r) => {
                const isOpen = open === r.userId
                const ops = isOpen ? userOps(r.userId) : []
                return [
                  <tr
                    key={r.userId}
                    className="cursor-pointer border-b border-line/50 hover:bg-white/[.02]"
                    onClick={() => setOpen(isOpen ? null : r.userId)}
                  >
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <ChevronDown size={13} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                        <span className="min-w-0">
                          <span className="block truncate text-fg">{r.name}</span>
                          {!!r.email && <span className="block truncate text-[11px] text-muted">{r.email}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmt(r.count)}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums text-spark-300">{r.usd ? `$${r.usd.toFixed(2)}` : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-amber-300/80">{r.coins ? `${fmtCoins(r.coins)} ⚡` : '—'}</td>
                    <td className="py-2 text-right tabular-nums text-faint">{fmtDt(r.lastAt)}</td>
                  </tr>,
                  isOpen ? (
                    <tr key={r.userId + '-ops'} className="border-b border-line/50 bg-white/[.02]">
                      <td colSpan={5} className="px-3 py-2">
                        {!ops.length ? (
                          <span className="text-xs text-muted">Пополнений за период нет.</span>
                        ) : (
                          <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                            {ops.map((o, i) => (
                              <div key={o.ts + '-' + i} className="flex items-baseline gap-x-2 border-b border-line/30 pb-1 text-xs last:border-0">
                                <span className={cn('rounded px-1 text-[10px] font-bold',
                                  o.kind === 'plan' ? 'bg-iris-500/15 text-iris-300' : o.kind === 'usd' ? 'bg-spark-500/15 text-spark-200' : 'bg-amber-500/12 text-amber-300')}>
                                  {o.kind === 'plan' ? 'план' : o.kind === 'usd' ? 'деньги $' : 'токены'}
                                </span>
                                <span className={cn('font-semibold tabular-nums', o.kind === 'plan' ? 'text-fg' : o.kind === 'usd' ? 'text-spark-200' : 'text-amber-300')}>
                                  {o.kind === 'plan' ? `${p.plans.currency}${o.amount}` : o.kind === 'usd' ? `+$${o.amount.toFixed(2)}` : `+${fmtCoins(o.amount)} ⚡`}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-muted">{o.label}</span>
                                <span className="ml-auto shrink-0 tabular-nums text-faint">{fmtDt(o.ts)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null,
                ]
              })}
              {!brought.length && (
                <tr><td colSpan={5} className="py-3 text-center text-xs text-muted">Пополнений пока нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/**
 * §5.1: провайдер по БАЗЕ ОПЛАТ (SQLite-индекс). Диапазон дат from–to, тип (монеты/планы),
 * поиск и пагинация — «найти покупку за месяц назад» без упора в срез последних N.
 */
function PaymentsExplorer() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<'' | 'usd' | 'coins' | 'plan'>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<PaymentsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const LIMIT = 50

  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : 0
  const toTs = to ? new Date(to + 'T23:59:59.999').getTime() : 0

  // Смена фильтра должна вернуть на 1-ю страницу БЕЗ лишнего запроса на старом offset
  // (раньше было два fetch: пустой на старой странице → мигание → правильный). Сравниваем
  // сигнатуру фильтров: при их изменении сбрасываем page и не грузим на этом проходе.
  const sig = `${fromTs}|${toTs}|${kind}|${q.trim()}`
  const lastSig = useRef(sig)
  useEffect(() => {
    if (lastSig.current !== sig && page !== 0) { lastSig.current = sig; setPage(0); return }
    lastSig.current = sig
    let alive = true
    setLoading(true)
    fetchPayments({ from: fromTs, to: toTs, kind, q: q.trim(), limit: LIMIT, offset: page * LIMIT })
      .then((d) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [sig, fromTs, toTs, kind, q, page])

  const fmtDt = (ts: number) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const s = data?.summary
  const total = data?.total ?? 0
  const items = data?.items ?? []
  const shownFrom = total ? page * LIMIT + 1 : 0
  const shownTo = Math.min(total, (page + 1) * LIMIT)
  const kinds: { v: '' | 'usd' | 'coins' | 'plan'; label: string }[] = [
    { v: '', label: 'Все' }, { v: 'usd', label: 'Деньги $' }, { v: 'coins', label: 'Токены ⚡' }, { v: 'plan', label: 'Планы $' },
  ]

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg">База оплат</span>
        {s && (
          <span className="text-xs text-muted">
            <b className="text-spark-300">${s.usdTotal ?? 0}</b> деньгами ({s.usdCount ?? 0}) · {s.coinsCount} поп. токенов на {fmtCoins(s.coinsTotal)} ⚡ · {s.planCount} планов на ${s.planTotal}
          </span>
        )}
        <RefreshCw size={13} className={cn('ml-auto text-muted', loading && 'animate-spin')} />
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">С<br /><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input h-9 text-sm" /></label>
        <label className="text-xs text-muted">По<br /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input h-9 text-sm" /></label>
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          {kinds.map((k) => (
            <button key={k.v} onClick={() => setKind(k.v)} className={cn('h-8 rounded-md px-2.5 font-semibold', kind === k.v ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:text-fg')}>{k.label}</button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Имя, почта или причина…" />
        </div>
      </div>

      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {items.map((r) => (
          <div key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/30 pb-1 text-xs last:border-0">
            <span className={cn('rounded px-1 text-[10px] font-bold',
              r.kind === 'plan' ? 'bg-iris-500/15 text-iris-300' : r.kind === 'usd' ? 'bg-spark-500/15 text-spark-200' : 'bg-amber-500/12 text-amber-300')}>
              {r.kind === 'plan' ? 'план' : r.kind === 'usd' ? 'деньги $' : 'токены'}
            </span>
            <span className="text-fg">{r.name}</span>
            {!!r.email && <span className="text-muted">{r.email}</span>}
            <span className={cn('font-semibold tabular-nums', r.kind === 'plan' ? 'text-fg' : r.kind === 'usd' ? 'text-spark-200' : 'text-amber-300')}>
              {r.kind === 'plan' ? `$${r.amount_fiat}` : r.kind === 'usd' ? `+$${r.amount_fiat}` : `+${fmtCoins(r.coins ?? 0)} ⚡`}
            </span>
            {/* §10.4: для пополнений токенами — $-эквивалент по курсу; для kind='usd' сумма уже в $. */}
            {r.kind === 'coins' && usdEq(r.coins, data?.coinUsd) && (
              <span className="tabular-nums text-[10px] text-muted">{usdEq(r.coins, data?.coinUsd)}</span>
            )}
            {!!r.reason && <span className="min-w-0 flex-1 truncate text-muted">{r.reason}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-faint">{fmtDt(r.ts)}</span>
          </div>
        ))}
        {!items.length && <div className="py-3 text-center text-xs text-muted">{loading ? 'Загрузка…' : 'Ничего не найдено за диапазон'}</div>}
      </div>

      {total > LIMIT && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>Показаны {shownFrom}–{shownTo} из {total}</span>
          <div className="flex gap-1">
            <button disabled={page === 0} onClick={() => setPage((n) => Math.max(0, n - 1))} className="btn-ghost h-7 px-2 disabled:opacity-40">← Назад</button>
            <button disabled={shownTo >= total} onClick={() => setPage((n) => n + 1)} className="btn-ghost h-7 px-2 disabled:opacity-40">Вперёд →</button>
          </div>
        </div>
      )}
    </Card>
  )
}

/**
 * §5.3: где сейчас болит. Три беды разведены намеренно — у них разные действия:
 * ошибки чинит настройка, бан/flood — замена аккаунта, пауза из-за денег — пополнение.
 */
/** Время записи лога — для журнала задачи дата+время важнее «просто даты». */
const fmtLogTs = (ts: number) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')

/**
 * §5.2 (MR-34): строка ошибочной задачи с раскрытием журнала.
 *
 * Раньше в «Проблемах» была только последняя строка ошибки — чтобы понять, что
 * произошло, приходилось идти в отдельный экран. Теперь по клику подгружаем логи
 * задачи (лениво, отдельным запросом — не тащим журналы всех задач в общий ответ)
 * и показываем причину и сам журнал рядом.
 */
function FailedTaskRow({ t }: { t: FailedTask }) {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<TaskLogs | 'loading' | 'error' | null>(null)
  const toggle = () => {
    const next = !open; setOpen(next)
    if (next && logs === null) {
      setLogs('loading')
      fetchTaskLogs(t.moduleKey, t.id).then((x) => setLogs(x)).catch(() => setLogs('error'))
    }
  }
  return (
    <div className="border-b border-line/40 pb-1.5 last:border-0">
      <button onClick={toggle} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left text-sm">
        <ChevronDown size={13} className={cn('mt-0.5 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
        <span className="font-medium text-fg">{t.title}</span>
        <span className="rounded-md bg-red-500/12 px-1.5 py-0.5 text-[11px] font-bold text-red-300">{t.errors} ош.</span>
        <span className="text-xs text-muted">{t.id}</span>
        {!!t.lastError && <span className="w-full text-xs text-muted sm:w-auto sm:flex-1 sm:truncate" title={t.lastError}>{t.lastError}</span>}
      </button>
      {open && (
        <div className="ml-5 mt-1.5 rounded-lg border border-line/50 bg-elevated/40 p-2">
          {logs === 'loading' ? (
            <div className="flex items-center gap-1.5 text-xs text-muted"><RefreshCw size={12} className="animate-spin" /> Загрузка логов…</div>
          ) : logs === 'error' ? (
            <div className="text-xs text-red-300">Не удалось загрузить логи задачи</div>
          ) : logs && typeof logs === 'object' && logs.logs.length ? (
            <div className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
              {logs.logs.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-muted/70">{fmtLogTs(l.ts)}</span>
                  <span className={cn('shrink-0 font-bold uppercase', l.level === 'error' ? 'text-red-300' : l.level === 'warn' ? 'text-amber-300' : 'text-muted')}>{l.level}</span>
                  {!!l.account && <span className="shrink-0 text-spark-300/80">{l.account}</span>}
                  <span className="min-w-0 break-words text-fg/90">{l.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted">Журнал задачи пуст</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * §5.2 (MR-34): один раздел вместо трёх — отчёт по модулям, статусы задач и ошибки
 * вместе. Оператору не нужно прыгать между вкладками, чтобы связать «какой модуль»,
 * «в каком статусе задачи» и «что за ошибка»: всё на одном экране, ошибки — с логами.
 */
function ProblemsTab({ p, health }: { p: Problems | null; health: AccountsHealth | null }) {
  if (!p) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  // «Спокойствие» считаем ТОЛЬКО по задачам: баны/flood/без-прокси аккаунтов теперь
  // отдельными блоками сверху (AccountsHealthBlocks) и не должны прятать зелёную плашку.
  const taskQuiet = !p.failedTotal && !p.pausedNoCoins.length
  const hasTasks = Object.keys(p.taskStatus || {}).length > 0

  return (
    <div className="space-y-3">
      {/* Статусы аккаунтов + «Падающие аккаунты — почему» — перенесены сюда из «Мониторинга». */}
      <AccountsHealthBlocks health={health} />

      {/* Нет ошибок задач → зелёная плашка (текст зависит от того, были ли задачи).
          Есть ошибки → три карточки-счётчика. Статусы задач и таблицы — ниже, всегда. */}
      {taskQuiet ? (
        <Card className="flex items-center gap-2 p-3 text-sm text-emerald-300">
          <Check size={16} /> {hasTasks
            ? 'По задачам ошибок и остановок из-за баланса нет — ниже статусы задач за период.'
            : 'По задачам всё спокойно — за выбранный период задач не было.'}
        </Card>
      ) : (
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Задач с ошибками</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.failedTotal)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Встали из-за баланса</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmt(p.pausedNoCoins.length)}</div>
          <div className="mt-0.5 text-[11px] text-muted">чинится пополнением</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Аккаунты</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(p.accounts.banned + p.accounts.flood)}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            бан {p.accounts.banned} · flood {p.accounts.flood} · без прокси {p.accounts.noProxy}
          </div>
        </Card>
      </div>
      )}

      {/* Статусы задач за период — раньше жили в «Панели», теперь рядом с ошибками. */}
      {hasTasks && <Breakdown title="Статусы задач за период" data={p.taskStatus} ru />}

      {/* Отчёт по модулям: задачи + статусы + ошибки в одной таблице. */}
      {!!p.modules.length && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">По модулям: задачи, статусы, ошибки</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Модуль</th>
                  <th className="px-2 py-1 text-right font-medium">Задач</th>
                  <th className="px-2 py-1 text-right font-medium">Готово</th>
                  <th className="px-2 py-1 text-right font-medium">Идут</th>
                  <th className="px-2 py-1 text-right font-medium">С ошибками</th>
                  <th className="py-1 pl-2 text-right font-medium">Ошибок</th>
                </tr>
              </thead>
              <tbody>
                {p.modules.map((m) => (
                  <tr key={m.key} className="border-t border-line/40">
                    <td className="py-1 pr-3 text-fg">{m.title}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-fg">{fmt(m.tasks)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">{fmt(m.done)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">{m.running ? fmt(m.running) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-amber-300">{m.errorTasks ? fmt(m.errorTasks) : '—'}</td>
                    <td className={cn('py-1 pl-2 text-right font-semibold tabular-nums', m.errors ? 'text-red-300' : 'text-muted')}>{m.errors ? fmt(m.errors) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!!p.failedTasks.length && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><ScrollText size={15} /> Где именно ошибки — причина и логи</div>
          <div className="space-y-1.5">
            {p.failedTasks.map((t) => <FailedTaskRow key={t.id} t={t} />)}
          </div>
          {p.failedTotal > p.failedTasks.length && (
            <div className="mt-2 text-[11px] text-muted">Показаны {p.failedTasks.length} из {p.failedTotal} — верхушка по числу ошибок.</div>
          )}
        </Card>
      )}

      {!!p.pausedNoCoins.length && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Ждут пополнения</div>
          <div className="text-sm text-muted">
            {p.pausedNoCoins.map((t) => t.title + ' (' + t.id + ')').join(' · ')}
          </div>
        </Card>
      )}
    </div>
  )
}

/**
 * CRM в админке: воронка и — главное — ЗАВИСШИЕ лиды.
 *
 * Их не видно ни в одном счётчике статусов: лид формально «в работе», а по факту
 * им никто не занимался несколько дней. Это и есть потерянные деньги, поэтому
 * вынесено отдельной цифрой, а не спрятано в разбивке.
 */
function CrmTab({ crm }: { crm: CrmOverview | null }) {
  if (!crm) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!crm.total) return <EmptyState icon={<Contact size={22} />} title="Лидов пока нет" desc="Появятся, когда модули начнут доводить людей до диалога." />

  const LABELS: Record<string, string> = {
    cold: 'Холодные', contacted: 'Написали', warm: 'Тёплые', interested: 'Заинтересованы',
    hot: 'Горячие', target: 'Целевое действие', closed: 'Закрыты',
  }
  const max = Math.max(...Object.values(crm.byStatus), 1)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-muted">Всего лидов</div>
          <div className="font-display text-2xl font-bold text-fg">{fmt(crm.total)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Горячие</div>
          <div className="font-display text-2xl font-bold text-spark-300">{fmt(crm.hot)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Зависшие</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmt(crm.stuck)}</div>
          <div className="mt-0.5 text-[11px] text-muted">в работе, но молчат больше {crm.stuckDays} дн.</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Конверсия в цель</div>
          <div className="font-display text-2xl font-bold text-fg">{crm.conversion}%</div>
          <div className="mt-0.5 text-[11px] text-muted">{fmt(crm.target)} довели до целевого</div>
        </Card>
      </div>

      {!!crm.owners.length && (
        <Card className="p-4">
          <div className="mb-2.5 text-sm font-semibold text-fg">Кто ведёт лидов</div>
          <div className="space-y-1.5">
            {crm.owners.map((o) => (
              <div key={o.accountId} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg">{o.name}</span>
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-spark-500/70" style={{ width: (o.count / Math.max(...crm.owners.map((x) => x.count), 1)) * 100 + '%' }} />
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums text-fg">{fmt(o.count)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 text-sm font-semibold text-fg">Воронка по статусам</div>
        <div className="space-y-1.5">
          {Object.entries(crm.byStatus).map(([k, v]) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-sm text-muted">{LABELS[k] || k}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-spark-500/70" style={{ width: (v / max) * 100 + '%' }} />
              </div>
              <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{fmt(v)}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* §5.3: полный список лидов ВСЕХ пользователей. Сводка выше отвечает «сколько»,
          а разбирать приходится конкретный случай: от кого пришёл, каким аккаунтом
          ведётся, чей юзер, из какой кампании — и открыть саму переписку. */}
      <CrmLeadsTable rows={crm.rows || []} labels={LABELS} />
    </div>
  )
}

/** Таблица всех лидов в админке + открытие переписки по клику. */
function CrmLeadsTable({ rows, labels }: { rows: NonNullable<CrmOverview['rows']>; labels: Record<string, string> }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [chat, setChat] = useState<{ peer: string; accountId: string } | null>(null)

  const needle = q.trim().toLowerCase()
  const shown = rows.filter((r) =>
    (!status || r.status === status)
    && (!needle || `${r.peer} ${r.accountName} ${r.userName} ${r.campaignName} ${r.taskId}`.toLowerCase().includes(needle)),
  )

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg">Все лиды</span>
        <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{rows.length}</span>
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Контакт, аккаунт, юзер, кампания…" />
        </div>
        <Select
          value={status}
          onChange={setStatus}
          className="w-44"
          options={[{ value: '', label: 'Все статусы' }, ...Object.entries(labels).map(([k, l]) => ({ value: k, label: l }))]}
        />
        <span className="text-xs text-muted">клик по строке — переписка аккаунта с этим человеком</span>
      </div>

      {!shown.length ? (
        <div className="py-6 text-center text-sm text-muted">Ничего не найдено по фильтру.</div>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="pb-2 pr-3 font-medium">Лид</th>
                <th className="pb-2 pr-3 font-medium">Статус</th>
                <th className="pb-2 pr-3 font-medium">Аккаунт</th>
                <th className="pb-2 pr-3 font-medium">Пользователь</th>
                <th className="pb-2 pr-3 font-medium">Источник</th>
                <th className="pb-2 text-right font-medium">Активность</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => r.accountId && setChat({ peer: r.peer, accountId: r.accountId })}
                  className={cn('border-b border-line/50', r.accountId ? 'cursor-pointer hover:bg-white/[.02]' : 'opacity-70')}
                  title={r.accountId ? 'Открыть переписку' : 'Нет аккаунта — переписку не прочитать'}
                >
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-fg">{r.peer}</span>
                      {r.isHot && <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">🔥</span>}
                    </span>
                    {r.note && <span className="block truncate text-[11px] text-muted">{r.note}</span>}
                  </td>
                  <td className="py-2 pr-3"><span className="text-xs text-fg">{labels[r.status] || r.status}</span></td>
                  <td className="py-2 pr-3">
                    <span className="block truncate text-xs text-fg">{r.accountName || '—'}</span>
                    {r.accountId && <span className="block truncate font-mono text-[10px] text-faint">{r.accountId}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="block truncate text-xs text-fg">{r.userName || '—'}</span>
                    {r.userId && <span className="block truncate font-mono text-[10px] text-faint">{r.userId}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="block truncate text-xs text-iris-300">{r.campaignName || '—'}</span>
                    {r.taskId && <span className="block truncate font-mono text-[10px] text-faint">задача {r.taskId.slice(-6)}</span>}
                  </td>
                  <td className="py-2 text-right text-xs text-muted">
                    {r.updatedAt ? new Date(r.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Переписка читается из самого Telegram аккаунтом-владельцем — тем же
          компонентом, что и в пользовательской CRM (одна логика на оба места). */}
      <LeadConversationModal
        source={chat ? { kind: 'peer', peer: chat.peer, accountId: chat.accountId } : null}
        onClose={() => setChat(null)}
      />
    </Card>
  )
}

/**
 * «Сейчас» — что идёт в эту минуту.
 *
 * Сводка за период отвечает «что было», но владельцу чаще нужно «что идёт»: успеет
 * ли до ночи, не встало ли, кто запустил. Вставшие из-за денег вынесены отдельно —
 * это единственная поломка, которую чинит не разбирательство, а пополнение.
 */
function ActiveTab({ active, onReload }: { active: ActiveNow | null; onReload: () => void }) {
  if (!active) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const nothing = !active.running.length && !active.paused.length
  if (nothing) return <EmptyState icon={<Activity size={22} />} title="Сейчас ничего не идёт" desc="Ни одной запущенной или приостановленной задачи." />

  const Row = ({ t }: { t: ActiveTask }) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/40 py-2 text-sm last:border-0">
      <span className="font-medium text-fg">{t.title}</span>
      <span className="text-xs text-muted">{t.id}</span>
      {t.pausedByCoins && (
        <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">ждёт пополнения</span>
      )}
      <span className="text-xs text-muted">{t.accounts} акк.</span>
      <div className="flex min-w-[120px] flex-1 items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <div className={cn('h-full rounded-full', t.status === 'running' ? 'bg-spark-500' : 'bg-amber-400/70')} style={{ width: t.percent + '%' }} />
        </div>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">
          {fmt(t.done)}{t.total ? '/' + fmt(t.total) : ''}
        </span>
      </div>
      {!!t.spentCoins && <span className="text-xs tabular-nums text-amber-300">{fmtCoins(t.spentCoins)} ⚡</span>}
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onReload} className="btn-ghost h-8 text-xs"><RefreshCw size={13} /> Обновить</button>
        <span className="text-xs text-muted">Данные на момент загрузки страницы.</span>
      </div>

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
          <Activity size={15} className="text-spark-400" /> Идёт сейчас
          <span className="text-muted">{active.running.length}</span>
        </div>
        {active.running.length
          ? active.running.map((t) => <Row key={t.id} t={t} />)
          : <div className="py-2 text-sm text-muted">Ничего не запущено.</div>}
      </Card>

      {!!active.paused.length && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            Приостановлены <span className="text-muted">{active.paused.length}</span>
          </div>
          {active.paused.map((t) => <Row key={t.id} t={t} />)}
        </Card>
      )}
    </div>
  )
}

/**
 * Расход по дням. Столбцы намеренно двухцветные: плата за действия и за ИИ ведут
 * себя по-разному, и «вчера потратили втрое больше» без ответа «на что» бесполезно.
 *
 * Точность источников разная, и подпись говорит это прямо: журнал ИИ пишет каждое
 * обращение с меткой времени, а плата за действия хранится итогом на задаче и
 * ложится на день её создания.
 */
function DailyTab({ daily }: { daily: DailySpend | null }) {
  if (!daily) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  const rows = daily.rows
  const max = Math.max(...rows.map((r) => r.coins), 0.001)
  const maxActions = Math.max(...rows.map((r) => r.actions), 1)
  const totalCoins = rows.reduce((n, r) => n + r.coins, 0)
  const busiest = rows.reduce((a, b) => (b.actions > a.actions ? b : a), rows[0])

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Потрачено за {daily.days} дн.</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmtCoins(totalCoins)} ⚡</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">В среднем в день</div>
          <div className="font-display text-2xl font-bold text-fg">{fmtCoins(totalCoins / Math.max(1, daily.days))} ⚡</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Самый нагруженный день</div>
          <div className="font-display text-2xl font-bold text-fg">{busiest ? fmt(busiest.actions) : 0}</div>
          <div className="mt-0.5 text-[11px] text-muted">{busiest ? busiest.day : '—'} · действий</div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-1 text-sm font-semibold text-fg">Монеты по дням</div>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-amber-400" /> за действия</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-spark-500" /> за ИИ</span>
        </div>
        <div className="flex h-40 items-end gap-1 overflow-x-auto">
          {rows.map((r) => {
            const h = (r.coins / max) * 100
            const aiPart = r.coins ? (r.tokenCoins / r.coins) * 100 : 0
            return (
              <div key={r.day} className="flex min-w-[14px] flex-1 flex-col items-center gap-1" title={`${r.day}: ${fmtCoins(r.coins)} ⚡ (действия ${fmtCoins(r.actionCoins)} + ИИ ${fmtCoins(r.tokenCoins)}) · ${fmt(r.actions)} действий`}>
                <div className="flex w-full flex-1 items-end">
                  <div className="w-full overflow-hidden rounded-t bg-line/40" style={{ height: Math.max(2, h) + '%' }}>
                    <div className="h-full w-full bg-amber-400/80">
                      <div className="w-full bg-spark-500" style={{ height: aiPart + '%' }} />
                    </div>
                  </div>
                </div>
                <span className="shrink-0 text-[9px] tabular-nums text-faint">{r.day.slice(8)}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Расход ИИ берётся из журнала обращений — с точной меткой времени. Плата за действия
          хранится итогом на задаче, поэтому ложится на день её создания.
        </p>
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-fg">Действия по дням</div>
        <div className="space-y-1">
          {rows.filter((r) => r.actions || r.tasks).map((r) => (
            <div key={r.day} className="flex items-center gap-3 text-xs">
              <span className="w-20 shrink-0 tabular-nums text-muted">{r.day}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-spark-500/60" style={{ width: (r.actions / maxActions) * 100 + '%' }} />
              </div>
              <span className="w-24 shrink-0 text-right tabular-nums text-fg">{fmt(r.actions)} действий</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted">{fmt(r.tasks)} задач</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

/**
 * §10.4: управление ценами ИЗ АДМИНКИ, а не правкой кода.
 *
 * Требование созвона 27.07: «внутри самого кода этого вообще быть не должно».
 * Две цены на модуль — ДОСТУП (подписка $/мес) и ИСПОЛЬЗОВАНИЕ (⚡ за действие),
 * плюс годовая скидка, курс токена и множитель за картинку. Меняешь тут — сразу на
 * витрине, в кабинете и в счёте. «изм.» помечает, где цена отличается от заводской.
 */
function PricesTab() {
  const pushToast = useApp((s) => s.pushToast)
  const [prices, setPrices] = useState<EffectivePrices | null>(null)
  const [draft, setDraft] = useState<Record<string, { month: string; action: string; gift: string }>>({})
  const [extra, setExtra] = useState({ annualDiscount: '', tokenUsd: '', imageMultiplier: '' })
  // §11.2: периоды подписки — редактируемый список (единица + количество + скидка),
  // а не «месяц/год» в коде. discount держим строкой в ПРОЦЕНТАХ, как в поле годовой.
  const [periods, setPeriods] = useState<{ unit: string; count: number; discount: string }[]>([])
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const p = await fetchPrices()
    setPrices(p)
    const d: Record<string, { month: string; action: string; gift: string }> = {}
    for (const m of p.modules) d[m.key] = { month: String(m.month), action: String(m.action), gift: String(m.gift || 0) }
    setDraft(d)
    setExtra({
      annualDiscount: String(Math.round(p.annualDiscount * 100)),
      // §10.1: авто-цена — поле ПУСТОЕ (пусто = «считать из модели»), рассчитанное
      // значение показываем плейсхолдером. Ручной override — показываем числом.
      tokenUsd: p.tokenUsdAuto ? '' : (p.tokenUsd == null ? '' : String(p.tokenUsd)),
      imageMultiplier: String(p.imageMultiplier),
    })
    setPeriods((p.periods || []).map((x) => ({ unit: x.unit, count: x.count, discount: String(Math.round(x.discount * 100)) })))
  }
  useEffect(() => { void load().catch(() => {}) }, [])

  if (!prices) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>

  const dirty =
    prices.modules.some((m) => draft[m.key] && (draft[m.key].month !== String(m.month) || draft[m.key].action !== String(m.action) || draft[m.key].gift !== String(m.gift || 0))) ||
    extra.annualDiscount !== String(Math.round(prices.annualDiscount * 100)) ||
    extra.tokenUsd !== (prices.tokenUsdAuto ? '' : (prices.tokenUsd == null ? '' : String(prices.tokenUsd))) ||
    extra.imageMultiplier !== String(prices.imageMultiplier) ||
    // §11.2: список периодов сравниваем целиком — состав и порядок тоже правка.
    JSON.stringify(periods.map((p) => ({ u: p.unit, c: p.count, d: p.discount }))) !==
      JSON.stringify((prices.periods || []).map((p) => ({ u: p.unit, c: p.count, d: String(Math.round(p.discount * 100)) })))

  const save = async () => {
    setSaving(true)
    try {
      const modules: Record<string, { month?: string; action?: string; gift?: string }> = {}
      for (const m of prices.modules) {
        const d = draft[m.key]
        if (d) modules[m.key] = { month: d.month, action: d.action, gift: d.gift }
      }
      const patch: PricePatch = { modules }
      // Пустое поле = вернуть заводскую скидку: шлём '' (бэкенд удалит override), а не 0 —
      // иначе Number('')===0 записал бы явные 0% поверх дефолта (как tokenUsd/картинка).
      if (extra.annualDiscount.trim() === '') patch.annualDiscount = ''
      else { const pct = Number(extra.annualDiscount); if (Number.isFinite(pct)) patch.annualDiscount = Math.max(0, Math.min(90, pct)) / 100 }
      patch.tokenUsd = extra.tokenUsd
      patch.imageMultiplier = extra.imageMultiplier
      // §11.2: проценты → доля. Сервер ещё раз нормализует (единица/пределы/дубли).
      patch.periods = periods.map((p) => ({
        unit: p.unit,
        count: p.count,
        discount: Math.max(0, Math.min(90, Number(p.discount) || 0)) / 100,
      }))
      const fresh = await savePrices(patch)
      setPrices(fresh)
      pushToast({ type: 'success', title: 'Цены сохранены', desc: 'Сразу на витрине, в кабинете и в счёте' })
      await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="mb-3 text-xs text-muted">
          Две цены на модуль: <b className="text-fg">Доступ</b> — подписка в $/мес, <b className="text-fg">Действие</b> — сколько ⚡
          списывается за одно действие. «изм.» — цена отличается от заводской; верните её обратно, и метка снимется.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="pb-2 pr-3 font-medium">Модуль</th>
                <th className="pb-2 pr-3 text-right font-medium">Доступ, $/мес</th>
                <th className="pb-2 pr-3 text-right font-medium">Действие, ⚡</th>
                <th className="pb-2 text-right font-medium">Подарок, ⚡</th>
              </tr>
            </thead>
            <tbody>
              {prices.modules.map((m) => (
                <tr key={m.key} className="border-b border-line/50">
                  <td className="py-1.5 pr-3 text-fg">{m.title}</td>
                  <td className="py-1.5 pr-3 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {m.overridden.month && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-300">изм.</span>}
                      <input value={draft[m.key]?.month ?? ''} inputMode="decimal"
                        onChange={(e) => setDraft((d) => ({ ...d, [m.key]: { ...d[m.key], month: cleanPrice(e.target.value, 100000) } }))}
                        className="input h-8 w-24 text-right tabular-nums" />
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {m.overridden.action && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-300">изм.</span>}
                      <input value={draft[m.key]?.action ?? ''} inputMode="decimal"
                        onChange={(e) => setDraft((d) => ({ ...d, [m.key]: { ...d[m.key], action: cleanPrice(e.target.value, 1000) } }))}
                        className="input h-8 w-24 text-right tabular-nums" />
                    </span>
                  </td>
                  {/* §3 (MR-21): подарочные токены на модуль — суммируются при выборе набора. */}
                  <td className="py-1.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {m.overridden.gift && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-300">изм.</span>}
                      <input value={draft[m.key]?.gift ?? ''} inputMode="numeric"
                        onChange={(e) => setDraft((d) => ({ ...d, [m.key]: { ...d[m.key], gift: e.target.value.replace(/[^\d]/g, '') } }))}
                        className="input h-8 w-24 text-right tabular-nums" placeholder="0" />
                    </span>
                    {/* На сколько ДЕЙСТВИЙ хватит подарочных токенов = подарок ÷ цена действия.
                        Считаем по текущему черновику — обновляется прямо при вводе подарка/цены. */}
                    {(() => {
                      const g = Number(draft[m.key]?.gift ?? m.gift ?? 0)
                      const a = Number(draft[m.key]?.action ?? m.action ?? 0)
                      if (!g || !a) return null
                      return <div className="mt-0.5 pr-1 text-[10px] text-muted">≈ {Math.floor(g / a).toLocaleString('ru-RU')} действий</div>
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Общие настройки</div>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-muted">Скидка за год, % <span className="text-faint">(0–90)</span></span>
            {/* Скидка не может быть больше 90% — тот же санитайзер cleanPrice, что и у цен. */}
            <input value={extra.annualDiscount}
              onChange={(e) => setExtra((x) => ({ ...x, annualDiscount: cleanPrice(e.target.value, 90) }))}
              className="input mt-1 h-9 w-full tabular-nums" inputMode="numeric" placeholder="20" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Цена токена, $ за 1 токен</span>
            <input value={extra.tokenUsd} onChange={(e) => setExtra((x) => ({ ...x, tokenUsd: cleanPrice(e.target.value, 1) }))}
              className="input mt-1 h-9 w-full tabular-nums" inputMode="decimal"
              placeholder={prices.tokenUsdComputed != null ? `авто: ${fmtUsd(prices.tokenUsdComputed)}` : 'авто'} />
            <span className="mt-1 block text-[10px] text-muted">
              {extra.tokenUsd.trim()
                ? 'Задано вручную. Очистите поле — вернётся авто-расчёт.'
                : <>Считается из модели <b className="text-fg">{prices.tokenUsdModel || '—'}</b> ≈ <b className="text-fg">${fmtUsd(prices.tokenUsdComputed)}</b>/токен. Впишите своё, чтобы переопределить.</>}
            </span>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Картинка дороже текста, ×</span>
            <input value={extra.imageMultiplier} onChange={(e) => setExtra((x) => ({ ...x, imageMultiplier: cleanPrice(e.target.value, 100) }))}
              className="input mt-1 h-9 w-full tabular-nums" inputMode="decimal" placeholder="4" />
          </label>
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Цена токена — <b className="text-fg">себестоимость у OpenAI</b>, платформа считает её сама из прайса текущей модели
          (обновляется при смене модели). Заполните поле только чтобы переопределить вручную; пусто = авто-расчёт.
          Множитель картинки (×N) — наценка на анализ изображения поверх токенов.
        </p>
      </Card>

      {/* §11.2: периоды подписки генерируемым списком — со звонка 29.07: «плюсик, чтобы
          добавить ещё, и период селектом», чтобы к этому больше не возвращаться. */}
      <Card className="p-4">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Периоды подписки и скидки</div>
        <p className="mb-3 text-[11px] text-muted">
          Из этого списка строится переключатель на витрине и в кабинете. Скидка считается от месячной цены —
          базовую цену модулей менять не нужно.
        </p>
        <div className="space-y-2">
          {periods.map((p, i) => {
            const max = p.unit === 'week' ? 4 : p.unit === 'month' ? 6 : 5
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  value={p.unit}
                  onChange={(e) => setPeriods((list) => list.map((x, k) => {
                    if (k !== i) return x
                    const unit = e.target.value
                    const lim = unit === 'week' ? 4 : unit === 'month' ? 6 : 5
                    return { ...x, unit, count: Math.min(x.count, lim) } // счёт не должен превысить предел новой единицы
                  }))}
                  className="input h-9 w-28 text-sm"
                >
                  <option value="week">недели</option>
                  <option value="month">месяцы</option>
                  <option value="year">годы</option>
                </select>
                <select
                  value={p.count}
                  onChange={(e) => setPeriods((list) => list.map((x, k) => (k === i ? { ...x, count: Number(e.target.value) } : x)))}
                  className="input h-9 w-20 text-sm tabular-nums"
                >
                  {Array.from({ length: max }, (_, n) => n + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <label className="flex items-center gap-1.5">
                  <span className="text-xs text-muted">скидка</span>
                  <input
                    value={p.discount}
                    onChange={(e) => setPeriods((list) => list.map((x, k) => (k === i ? { ...x, discount: cleanPrice(e.target.value, 90) } : x)))}
                    className="input h-9 w-16 text-sm tabular-nums" inputMode="numeric" placeholder="0" />
                  <span className="text-xs text-muted">%</span>
                </label>
                <button
                  onClick={() => setPeriods((list) => list.filter((_, k) => k !== i))}
                  title="Убрать период"
                  className="grid h-9 w-9 place-items-center rounded-xl border border-line text-muted transition-colors hover:border-red-500/40 hover:text-red-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
          {!periods.length && <div className="text-xs text-muted">Периодов нет — витрина покажет только помесячную оплату.</div>}
        </div>
        <button
          onClick={() => setPeriods((list) => [...list, { unit: 'month', count: 3, discount: '10' }])}
          className="btn-ghost mt-3 h-9 rounded-xl border border-line px-3 text-sm"
        >
          + Добавить период
        </button>
      </Card>

      {/* §10.4/§10.6: готовые наборы (что продаём) — собираются и правятся из админки. */}
      <BundlesEditor modules={prices.modules} currency="$" />

      <div className="sticky bottom-4 flex items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 backdrop-blur-xl">
        <span className="text-xs text-muted">Изменения применяются сразу к витрине, кабинету и счёту клиенту.</span>
        <button onClick={() => void save()} disabled={saving || !dirty} className="btn-primary ml-auto h-10 min-w-[140px] disabled:opacity-40">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Сохранить цены
        </button>
      </div>
    </div>
  )
}
