import { useMemo, useState, useEffect, useRef } from 'react'
import {
  Plus, UploadCloud, Server, RefreshCw, ListChecks, Search, Filter,
  MoreHorizontal, Trash2, KeyRound, Info, Users, Undo2, Loader2, Pause,
  Lock, LockOpen, Rocket, AlertTriangle, ShieldCheck, Clock, Play, Square, Power, Moon, Eye,
} from 'lucide-react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useApp, activeAccounts, trashedAccounts, STATUS_META } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { filterAccountsByAccess } from '@/shared/lib/access'
import { useUi } from '@/shared/lib/uiStore'
import {
  PageHeader, Avatar, StatusBadge, EmptyState, Dropdown, MenuItem, Select, Skeleton, Modal, NumberField, useTooltip,
} from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { accountLabel, accountSub } from '@/features/conversation/AccountRail'
import { AddAccountWizard } from '@/features/add-tg-account/AddAccountWizard'
import { ImportModal } from '@/features/import-sessions/ImportModal'
import { ProxyPoolModal } from '@/features/proxy/ProxyPoolModal'
import { AccountManagementModal } from '@/features/account-manager/AccountManagementModal'
import { ChangeProxyModal } from '@/features/account-manager/ChangeProxyModal'
import { AiSafetyModal } from '@/features/modules/shared'
import { PaywallLock } from '@/features/paywall/Paywall'
import { cn } from '@/shared/lib/utils'
import { ROLES } from '@/shared/config/modules'
import { countryOptionsFrom, matchesGeo } from '@/shared/config/geo'
import { confirmDialog, promptDialog } from '@/shared/lib/dialog'
import type { AccountStatus, TgAccount } from '@/shared/types'
import { patchAccount, releaseAccountLock, setAccountStatusManual, fetchDailyAll, type DailyAllMap } from '@/api/accountsApi'
import { fetchCampaigns, updateCampaign, type Campaign, type PinnedMap } from '@/api/campaignsApi'
import { fetchAccountGroups, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchProxies, toProxyUrl, isUsableProxy, type Proxy as ApiProxy } from '@/api/proxiesApi'
import { assignProxies, proxyCapacity } from '@/api/accountImportApi'
import { fetchActivity, setActivity, type ActivityMap, type SchedulePercent } from '@/api/accountActivityApi'
import { startUnblock } from '@/api/accountActivityApi'
import { useTabParam } from '@/shared/lib/useTabParam'

const STATUS_ORDER: AccountStatus[] = ['active', 'working', 'warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'invalid', 'frozen', 'reauth']

// Правка 14.08: подсказка по каждому статусу — при наведении на карточку (как в блоке «Защита»).
const STATUS_TIP: Record<AccountStatus, string> = {
  active: 'Свободен, готов к работе',
  working: 'Занят задачей прямо сейчас',
  warming: 'Идёт прогрев аккаунта',
  pause: 'Временно остановлен оператором',
  floodwait: 'Telegram временно ограничил действия — ждём снятия по сроку',
  quarantine: 'Отдыхает после риска (карантин)',
  spamblock: 'Ограничен спам-фильтром Telegram — снимите через @SpamBot',
  invalid: 'Сессия недействительна — нужен повторный вход',
  frozen: 'Отключён вручную',
  reauth: 'Требуется повторный вход (реавторизация)',
}

// Правка 14.08: «Зона риска» — это не один статус, а несколько независимых причин.
// Заказчик просил показать их ОТДЕЛЬНЫМИ плитками-счётчиками (мёртвый прокси, нет
// прокси, низкое доверие), а не свалкой в один бейдж. Каждая — отдельный фильтр.
type RiskKey = 'deadProxy' | 'noProxy' | 'lowTrust'
const RISK_ORDER: RiskKey[] = ['deadProxy', 'noProxy', 'lowTrust']
const RISK_META: Record<RiskKey, { label: string; dot: string; bg: string; tip: string; match: (a: { proxyOk?: boolean; noProxy?: boolean; trustBand?: string }) => boolean }> = {
  deadProxy: { label: 'Мёртвый прокси', dot: 'bg-rose-400', bg: 'bg-rose-500/12 border-rose-500/30', tip: 'Прокси не отвечает — Telegram видит смену IP, высокий риск блокировки. Назначьте рабочий прокси.', match: (a) => a.proxyOk === false && a.noProxy !== true },
  noProxy: { label: 'Нет прокси', dot: 'bg-orange-400', bg: 'bg-orange-500/12 border-orange-500/30', tip: 'Без прокси — работа с реального IP сервера. Назначьте прокси.', match: (a) => a.noProxy === true },
  lowTrust: { label: 'Низкое доверие', dot: 'bg-amber-400', bg: 'bg-amber-500/12 border-amber-500/30', tip: 'Низкий trust — модули работают консервативно, риск ограничений выше.', match: (a) => a.trustBand === 'low' },
}

// Правка 14.08: единый кастомный тултип (как у кнопок-иконок) — оборачиваем элементы вместо
// нативного title, который выглядит некрасиво (широкая браузерная плашка).
// Всплывашка рендерится ПОРТАЛОМ в body (position: fixed) — иначе таблица в контейнере
// overflow-x-auto обрезала бы её у верхних строк. Позицию считаем на наведении.
function Tip({ text, children, className }: { text: string; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left + r.width / 2, y: r.top })
  }
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      className={cn('relative inline-flex', className)}
    >
      {children}
      {pos && createPortal(
        <span
          role="tooltip"
          style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)' }}
          className="pointer-events-none z-[200] w-max max-w-[260px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium normal-case leading-snug text-fg shadow-xl"
        >{text}</span>,
        document.body,
      )}
    </span>
  )
}

// Правка 14.08: на строке показываем КОНКРЕТНУЮ причину (Нет прокси / Мёртвый прокси /
// Низкое доверие), а не общий бейдж «Зона риска» — статусы теперь раздельные.
function RiskChip({ a }: { a: { proxyOk?: boolean; noProxy?: boolean; trustBand?: string } }) {
  const rk = RISK_ORDER.find((k) => RISK_META[k].match(a))
  if (!rk) return null
  const m = RISK_META[rk]
  const text = rk === 'deadProxy' ? 'text-rose-300' : rk === 'noProxy' ? 'text-orange-300' : 'text-amber-300'
  // MR-162: кастомный тултип (как у соседних чипов строки — усталость/лимиты), а не native title.
  return (
    <Tip text={m.tip} className={cn('items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-bold', m.bg, text)}>
      <AlertTriangle size={12} /> {m.label}
    </Tip>
  )
}

// Правка 14.08: кнопки-иконки с кастомным тёмным плавающим тултипом (не нативный title).
// Панель управления и тулбар просили сделать иконками с всплывашкой при наведении.
function IconBtn({ icon, label, onClick, disabled, tone, active }: {
  icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; tone?: string; active?: boolean
}) {
  return (
    <span className="group/ib relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'grid h-9 w-9 place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed',
          disabled ? 'border-line text-white/25' : (active ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : (tone || 'border-line text-fg hover:bg-elevated')),
        )}
      >
        {icon}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-medium text-fg opacity-0 shadow-xl transition-opacity group-hover/ib:opacity-100"
      >
        {label}
      </span>
    </span>
  )
}
const COLS = [
  { key: 'avatar', label: 'Аватар' },
  { key: 'name', label: 'Имя' },
  // MR-154 (созвон 12.08): колонку «Кампания» скрыли — кампаний в системе пока нет
  // («компании надо убрать, у нас же сейчас нету компаний»). Код кампаний остаётся,
  // вернуть колонку = раскомментировать строку ниже.
  // { key: 'campaign', label: 'Кампания' },
  { key: 'fatigue', label: 'Усталость' },
  { key: 'status', label: 'Статус' },
  { key: 'lastSeen', label: 'Отлёжка' },
  { key: 'proxy', label: 'Прокси' },
]
const DAILY_CAP_LABELS: Record<string, string> = { comments: 'комментарии', dm: 'ЛС', joins: 'вступления', reactions: 'реакции' }
/**
 * §2: чекбокс-заголовок с тремя состояниями. `indeterminate` в DOM нельзя выставить
 * через атрибут — только через ref, поэтому отдельный компонент.
 */
function TriStateCheckbox({ checked, indeterminate, onChange, title }: {
  checked: boolean; indeterminate: boolean; onChange: () => void; title?: string
}) {
  // MR-162: кастомный тултип вместо нативного title. t.ref используем и для indeterminate.
  const t = useTooltip<HTMLInputElement>(title)
  useEffect(() => { if (t.ref.current) t.ref.current.indeterminate = indeterminate && !checked }, [indeterminate, checked, t.ref])
  return (
    <>
      <input
        ref={t.ref}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        onMouseEnter={t.onMouseEnter}
        onMouseLeave={t.onMouseLeave}
        className="h-4 w-4 rounded border-line accent-spark-500"
      />
      {t.node}
    </>
  )
}

// MR-154: расшифровка статусов — по «?» рядом с заголовком колонки.
const STATUS_HELP = [
  'Активные — свободен, готов к работе',
  'В работе — занят задачей прямо сейчас',
  'Прогрев — идёт прогрев аккаунта',
  'На паузе — временно остановлен',
  'FloodWait — Telegram временно ограничил действия',
  'На карантине — отдыхает после риска',
  'Спамблок — ограничен спам-фильтром Telegram',
  'Невалидные — сессия недействительна, нужен повторный вход',
  'Замороженные — отключён вручную',
  'Реавторизация — требуется повторный вход',
  '— — —',
  'Мёртвый прокси — прокси не отвечает, высокий риск блокировки. Показывается вместо «Активные».',
  'Нет прокси — работа с реального IP сервера, назначьте прокси.',
  'Низкое доверие — низкий trust, модули работают консервативно.',
].join('\n')

function formatProxyLabel(proxy: string) {
  if (!proxy || proxy === '—') return 'Прямое подключение'
  return proxy
}

/** Есть ли у аккаунта свой выход в сеть. Прочерк и пустая строка — одно и то же. */
function hasProxy(a: { proxy?: string }) {
  const p = String(a?.proxy || '').trim()
  return !!p && p !== '—'
}

/**
 * Сортировки списка аккаунтов. Держим таблицей функций, а не цепочкой if: добавить
 * порядок = добавить строку, и подпись в выпадающем списке не разъедется с логикой.
 *
 * `default` — прежнее поведение: занятые в работе уходят вниз, чтобы свободные,
 * которые и надо выбирать для запуска, были под рукой.
 */
type SortKey = 'default' | 'problems' | 'name' | 'status' | 'country' | 'newest' | 'oldest'

const str = (v: unknown) => String(v ?? '')
// MR-154: «отвалившийся» аккаунт — нет прокси / прокси не отвечает / нерабочий статус.
const PROBLEM_STATUSES = new Set(['invalid', 'reauth', 'spamblock', 'quarantine', 'frozen'])
const isProblemAccount = (a: TgAccount) => !hasProxy(a) || a.proxyOk === false || PROBLEM_STATUSES.has(str(a.status))
// Кириллица (0) — выше латиницы (1); пустое имя — в самый низ.
const scriptRank = (s: string) => { const c = s.trim(); return !c ? 2 : /^[Ѐ-ӿ]/.test(c) ? 0 : 1 }
const SORTS: Record<SortKey, (a: TgAccount, b: TgAccount) => number> = {
  // MR-129: порядок как просил заказчик — (1) свободные/занятые, (2) по прокси-региону
  // (одинаковый прокси/регион рядом; без прокси — в конце своей группы), (3) по алфавиту.
  default: (a, b) =>
    (Number(!!a.busyIn) - Number(!!b.busyIn))
    || (Number(!hasProxy(a)) - Number(!hasProxy(b)))
    || str(a.proxy).localeCompare(str(b.proxy))
    || str(a.name || a.username).localeCompare(str(b.name || b.username), 'ru'),
  // MR-154: проблемные сверху, затем кириллица→латиница, затем по алфавиту.
  problems: (a, b) =>
    (Number(isProblemAccount(b)) - Number(isProblemAccount(a)))
    || (scriptRank(str(a.name || a.username)) - scriptRank(str(b.name || b.username)))
    || str(a.name || a.username).localeCompare(str(b.name || b.username), 'ru'),
  name: (a, b) => str(a.name || a.username).localeCompare(str(b.name || b.username), 'ru'),
  status: (a, b) => str(a.status).localeCompare(str(b.status)),
  country: (a, b) => str(a.country).localeCompare(str(b.country), 'ru'),
  // Свежие сверху: у аккаунтов без даты ставим 0, иначе они всплывали бы наверх.
  newest: (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0),
  oldest: (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0),
}

const SORT_LABELS: { key: SortKey; label: string }[] = [
  { key: 'default', label: 'Свободные сверху' },
  { key: 'problems', label: 'Проблемные сверху' },
  { key: 'name', label: 'По имени' },
  { key: 'status', label: 'По статусу' },
  { key: 'country', label: 'По стране' },
  { key: 'newest', label: 'Сначала новые' },
  { key: 'oldest', label: 'Сначала старые' },
]

export function AccountsPage() {
  const data = useApp((s) => s.data)
  const isNoSub = useApp((s) => s.userState === 'no-sub')
  const trashAccount = useApp((s) => s.trashAccount)
  const restoreAccount = useApp((s) => s.restoreAccount)
  const emptyTrash = useApp((s) => s.emptyTrash)
  const setAccountStatus = useApp((s) => s.setAccountStatus)
  const setAccountProxy = useApp((s) => s.setAccountProxy)
  const loadAccounts = useApp((s) => s.loadAccounts)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const accountsLoading = useApp((s) => s.accountsLoading)
  const pushToast = useApp((s) => s.pushToast)
  const sessionUser = useSession((s) => s.user)
  const setTasksOpen = useUi((s) => s.setTasksOpen)
  const navigate = useNavigate() // §3: обзор аккаунта — вьюшка, а не модалка

  const [tab, setTab] = useTabParam<'accounts' | 'trash'>('accounts')
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'all'>('all')
  const [riskFilter, setRiskFilter] = useState<RiskKey | 'all'>('all')
  // Правка 14.08: единый источник прокси — каталог (страница «Прокси»). В менеджере в колонке
  // «Прокси» показываем НАЗВАНИЕ прокси из каталога (напр. «PL TEST 2»), а не сырой адрес.
  const [proxyNames, setProxyNames] = useState<Record<string, string>>({})
  useEffect(() => {
    void fetchProxies().then((list) => {
      const m: Record<string, string> = {}
      for (const p of list) if (p.label) m[`${p.host}:${p.port}`] = p.label
      setProxyNames(m)
    }).catch(() => {})
  }, [])
  // Имя прокси по его URL (матчим по host:port — пароль/логин в строке могут отличаться форматом).
  const proxyName = (url: string): string => {
    const hp = (/^[a-z0-9]+:\/\/(?:[^@]*@)?([^/]+)/i.exec(url || '') || [])[1] || ''
    return proxyNames[hp] || formatProxyLabel(url)
  }
  const [roleFilter, setRoleFilter] = useState('Все роли')
  // §1: «роль как группа» уходит — аккаунт работает ПОД КАМПАНИЕЙ. Закрепление живёт
  // в самой кампании (см. server/campaigns.js), поэтому accountsMeta.role не трогаем.
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({})
  // Фильтр «Кампания» скрыт (14.08) — оставляем 'all', сеттер не нужен.
  const [campaignFilter] = useState('all')
  const [trashAlive, setTrashAlive] = useState(false) // §2: показать только «живые» среди удалённых
  // §12: без списка групп доступ роли «на группу» не применялся бы (был баг — фильтр не видел групп).
  const [accGroups, setAccGroups] = useState<AccountGroup[]>([])
  useEffect(() => { void fetchAccountGroups().then(({ groups }) => setAccGroups(groups)).catch(() => {}) }, [])
  const loadCampaigns = () => {
    void fetchCampaigns().then(({ campaigns: cs, pinned }) => { setCampaigns(cs); setPinnedMap(pinned) }).catch(() => {})
  }
  // Кампании обновляем ПЕРИОДИЧЕСКИ, как и аккаунты. Раньше здесь был useEffect с
  // пустыми зависимостями — список кампаний и карта закреплений грузились ОДИН раз
  // при открытии, тогда как аккаунты освежались каждые 30 с. Кампанию, созданную на
  // другой странице, менеджер не видел: её не было в фильтре, а её аккаунты
  // показывались «в общем пуле», хотя были закреплены. Оператор раздавал их другой
  // кампании, ломая закрепление (прогон 21–22.07, тест 3.1).
  useEffect(() => {
    loadCampaigns()
    const t = setInterval(loadCampaigns, 30000)
    return () => clearInterval(t)
  }, [])
  // §4 (D1/D3): усталость общая для всех модулей — показываем в списке, кто отдыхает.
  const [activity, setActivityMap] = useState<ActivityMap>({})
  const [fatigueOpen, setFatigueOpen] = useState(false)
  const [unblockOpen, setUnblockOpen] = useState(false)
  // §4 (D2): фильтр по усталости — ползунок «показать усталость ≥ N%» (вместо колонки «Проект»).
  const [fatigueMin, setFatigueMin] = useState(0)
  // Усталость можно задать и ОДНОМУ аккаунту (не только массово): клик по ячейке усталости.
  const [fatigueOne, setFatigueOne] = useState<string | null>(null)
  /** Усталость аккаунта в процентах от порога (0, если порог не задан). */
  const fatiguePct = (id: string) => {
    const act = activity[id]
    return act && act.threshold > 0 ? Math.min(100, Math.round((act.fatigue / act.threshold) * 100)) : 0
  }
  const [assignProxyOpen, setAssignProxyOpen] = useState(false)
  useEffect(() => {
    const load = () => { void fetchActivity().then(setActivityMap).catch(() => {}) }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  const [assignAcc, setAssignAcc] = useState<TgAccount | null>(null) // §1: назначить кампанию одному аккаунту
  /**
   * §1: назначить аккаунт кампании — «присвоить (лок)» или «использовать (без лока)».
   * Правим список аккаунтов самой кампании: закрепление живёт там, а не в accountsMeta.
   */
  const assignToCampaign = async (accountId: string, campaignId: string, lock: boolean) => {
    try {
      // Сначала убираем аккаунт из прежних кампаний, чтобы не висел в двух местах.
      for (const c of campaigns) {
        if ((c.accountIds || []).includes(accountId) && c.id !== campaignId) {
          await updateCampaign(c.id, { accountIds: c.accountIds.filter((x) => x !== accountId) })
        }
      }
      if (campaignId) {
        const target = campaigns.find((c) => c.id === campaignId)
        if (target) {
          const ids = [...new Set([...(target.accountIds || []), accountId])]
          // pinned — политика ВСЕЙ кампании, а не свойство одного аккаунта. Раньше он
          // уходил в патч всегда, и галочка «закрепить» из маленького диалога назначения
          // переписывала режим закрепления кампании и всех остальных её аккаунтов:
          // «Тест 6» была pinned=true, её не редактировали — после назначения одного
          // аккаунта закрепление слетело со всех (прогон 21–22.07, тест 3.5).
          // Отправляем pinned только когда кампания ЕЩЁ пуста и политику задаём впервые.
          const firstAccount = (target.accountIds || []).length === 0
          await updateCampaign(campaignId, firstAccount ? { accountIds: ids, pinned: lock } : { accountIds: ids })
        }
      }
      loadCampaigns()
      pushToast({ type: 'success', title: campaignId ? (lock ? 'Аккаунт закреплён за кампанией' : 'Аккаунт добавлен в кампанию без лока') : 'Аккаунт возвращён в общий пул' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось назначить', desc: e instanceof Error ? e.message : '' })
    }
    setAssignAcc(null)
  }


  /** §1: под какой кампанией аккаунт и закреплён ли (замочек). */
  const campaignOf = (accountId: string) => {
    const pin = pinnedMap[accountId]
    if (pin) return { name: pin.name, locked: true }
    const c = campaigns.find((x) => (x.accountIds || []).includes(accountId))
    return c ? { name: c.name, locked: false } : null
  }
  const [countryFilter, setCountryFilter] = useState('all')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [moveOpen, setMoveOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Правка 14.08: кнопка «Колонки» убрана — 6 колонок фиксированы, набор больше не меняется.
  const [visibleCols] = useState<string[]>(COLS.map((c) => c.key))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  const [addOpen, setAddOpen] = useState(false)
  const [wizardMode, setWizardMode] = useState<'add' | 'reauth'>('add')
  const [reauthTarget, setReauthTarget] = useState<TgAccount | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [proxyPoolOpen, setProxyPoolOpen] = useState(false)
  const [detailAcc, setDetailAcc] = useState<TgAccount | null>(null)
  // Сортировка списка. По умолчанию «занятые вниз» — так было и раньше, но теперь
  // это осознанный выбор из списка, а не единственный жёсткий порядок.
  const [sortKey, setSortKey] = useState<SortKey>('default')
  const [proxyAcc, setProxyAcc] = useState<TgAccount | null>(null)

  const loading = accountsLoading

  // R4: не-админ видит в менеджере только выданные его роли аккаунты (демо/нет сессии — все).
  const active = sessionUser
    ? filterAccountsByAccess(activeAccounts(data), sessionUser.permissions, sessionUser.isAdmin, accGroups)
    : activeAccounts(data)
  const trashed = sessionUser
    ? filterAccountsByAccess(trashedAccounts(data), sessionUser.permissions, sessionUser.isAdmin, accGroups)
    : trashedAccounts(data)

  // §6: сводка суточных лимитов по аккаунтам (для индикатора throttle в списке).
  const [dailyAll, setDailyAll] = useState<DailyAllMap>({})
  useEffect(() => {
    let alive = true
    const load = () => { void fetchDailyAll().then((m) => { if (alive) setDailyAll(m) }).catch(() => {}) }
    load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const statusCounts = useMemo(() => {
    const c: Record<AccountStatus, number> = { active: 0, working: 0, warming: 0, pause: 0, floodwait: 0, quarantine: 0, spamblock: 0, invalid: 0, frozen: 0, reauth: 0 }
    for (const a of active) c[a.status] += 1
    return c
  }, [active])

  // Правка 14.08: счётчики причин риска — отдельно (мёртвый прокси / нет прокси / низкое доверие).
  // Один аккаунт может попасть в несколько (у него бывает и мёртвый прокси, и низкий trust).
  const riskCounts = useMemo(() => {
    const c: Record<RiskKey, number> = { deadProxy: 0, noProxy: 0, lowTrust: 0 }
    for (const a of active) for (const k of RISK_ORDER) if (RISK_META[k].match(a)) c[k] += 1
    return c
  }, [active])

  // (8) Сводка по модулям: сколько аккаунтов сейчас работают в каждом модуле.
  const moduleSummary = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>()
    for (const a of active) {
      if (!a.busyIn) continue
      const cur = map.get(a.busyIn.moduleKey) || { label: a.busyIn.moduleLabel, count: 0 }
      cur.count += 1
      map.set(a.busyIn.moduleKey, cur)
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }))
  }, [active])

  const source = tab === 'accounts' ? active : trashed
  const filtered = useMemo(() => {
    const list = source.filter((a) => {
      if (tab === 'accounts' && statusFilter !== 'all' && a.status !== statusFilter) return false
      if (tab === 'accounts' && riskFilter !== 'all' && !RISK_META[riskFilter].match(a)) return false
      // §2: в корзине можно отсеять «мёртвые» — оставить только валидные сессии.
      if (tab === 'trash' && trashAlive && (a.status === 'invalid' || a.status === 'reauth')) return false
      if (campaignFilter === 'pool' && campaignOf(a.id)) return false
      if (campaignFilter !== 'all' && campaignFilter !== 'pool') {
        const c = campaigns.find((x) => x.id === campaignFilter)
        if (!c || !(c.accountIds || []).includes(a.id)) return false
      }
      if (!matchesGeo(a.country, countryFilter)) return false
      if (tab === 'accounts' && moduleFilter !== 'all') {
        if (moduleFilter === 'idle') { if (a.busyIn) return false }
        else if (a.busyIn?.moduleKey !== moduleFilter) return false
      }
      if (query && !`${a.name} ${a.username} ${a.phone}`.toLowerCase().includes(query.toLowerCase())) return false
      // §4 (D2): порог усталости — показываем только устающих ≥ N%.
      if (fatigueMin > 0 && fatiguePct(a.id) < fatigueMin) return false
      return true
    })
    // Сортируем стабильно: сравнение по ключу, при равенстве — исходный порядок,
    // иначе строки прыгали бы между перерисовками при одинаковых значениях.
    const cmp = SORTS[sortKey]
    return list
      .map((a, i) => ({ a, i }))
      .sort((x, y) => cmp(x.a, y.a) || (x.i - y.i))
      .map((x) => x.a)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, tab, statusFilter, riskFilter, campaignFilter, campaigns, pinnedMap, countryFilter, moduleFilter, query, trashAlive, sortKey, fatigueMin, activity])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageItems = filtered.slice(page * pageSize, page * pageSize + pageSize)

  const allOnPageSelected = pageItems.length > 0 && pageItems.every((a) => selected.has(a.id))
  // §2: чекбокс-заголовок 3 состояния. Частичный выбор (semi) — клик снимает ВСЁ,
  // поэтому отдельная кнопка «Снять» больше не нужна.
  const someOnPageSelected = pageItems.some((a) => selected.has(a.id)) && !allOnPageSelected
  const toggleAll = () => {
    const next = new Set(selected)
    if (allOnPageSelected || someOnPageSelected) pageItems.forEach((a) => next.delete(a.id))
    else pageItems.forEach((a) => next.add(a.id))
    setSelected(next)
  }
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  // #2 (§3.2): подтверждение массовых действий. ≤1 акк — без спроса; 2–10 — одно
  // подтверждение; >10 — второе подтверждение вводом числа (в другом месте, защита
  // от «прокликивания» двойным кликом в одну точку).
  const confirmBulk = async (count: number, actionText: string): Promise<boolean> => {
    if (count <= 1) return true
    if (!(await confirmDialog({ title: 'Массовое действие', message: `Вы уверены, что хотите ${actionText} ${count} аккаунт(ов)?`, confirmLabel: 'Продолжить' }))) return false
    if (count > 10) {
      const typed = await promptDialog({ title: 'Двойное подтверждение', message: `Это затронет ${count} аккаунтов. Для подтверждения введите число ${count}:`, placeholder: String(count) })
      if (String(typed ?? '').trim() !== String(count)) {
        pushToast({ type: 'info', title: 'Отменено', desc: 'Число не совпало — действие не выполнено.' })
        return false
      }
    }
    return true
  }

  /** §2: аккаунт «в работе» нельзя удалять — сначала стоп (иначе уходил в корзину, не меняя статус). */
  const busySelected = useMemo(
    () => [...selected]
      .map((id) => active.find((a) => a.id === id))
      .filter((a): a is TgAccount => !!a && (!!a.busyIn || a.status === 'working' || a.status === 'warming')),
    [selected, active],
  )

  /** §2: восстановить выбранные из корзины (раньше — только по одному). */
  const bulkRestore = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!(await confirmBulk(ids.length, 'восстановить из корзины'))) return
    for (const id of ids) { try { await restoreAccount(id) } catch { /* skip */ } }
    pushToast({ type: 'success', title: `Восстановлено: ${ids.length}`, desc: 'Аккаунты вернулись в список.' })
    setSelected(new Set())
  }

  const bulkTrash = async () => {
    if (busySelected.length) {
      return pushToast({
        type: 'error',
        title: 'Сначала остановите работу',
        desc: `${busySelected.length} акк. в работе/прогреве — удалить нельзя. Нажмите «Стоп / освободить», затем в корзину.`,
      })
    }
    if (!(await confirmBulk(selected.size, 'переместить в корзину'))) return
    void (async () => {
      for (const id of selected) await trashAccount(id)
      pushToast({ type: 'success', title: `В корзину: ${selected.size}`, desc: 'Аккаунты перемещены в корзину.' })
      setSelected(new Set())
    })()
  }

  // (8) Массовые действия
  const bulkSetStatus = async (status: AccountStatus, title: string) => {
    if (!(await confirmBulk(selected.size, status === 'frozen' ? 'отключить (frozen)' : `перевести в «${title}»`))) return
    void (async () => {
      const ids = [...selected]
      for (const id of ids) { try { await patchAccount(id, { status }) } catch { /* skip */ } }
      await loadAccounts()
      pushToast({ type: 'success', title, desc: `Аккаунтов: ${ids.length}` })
      setSelected(new Set())
    })()
  }

  // Ручная пауза/возврат оператором — через аудируемый эндпоинт (§3.3/§4).
  const bulkStatusManual = async (to: 'pause' | 'active', title: string) => {
    if (!(await confirmBulk(selected.size, to === 'pause' ? 'поставить на паузу' : 'включить'))) return
    void (async () => {
      const ids = [...selected]
      let ok = 0
      for (const id of ids) {
        try {
          const r = await setAccountStatusManual(id, to)
          if (r.ok) ok += 1
        } catch { /* skip */ }
      }
      await loadAccounts()
      pushToast({ type: 'success', title, desc: `Аккаунтов: ${ok} из ${ids.length}` })
      setSelected(new Set())
    })()
  }

  const bulkRelease = async () => {
    if (!(await confirmBulk(selected.size, 'остановить / освободить'))) return
    void (async () => {
      const ids = [...selected]
      let released = 0
      for (const id of ids) {
        try {
          const r = await releaseAccountLock(id)
          if (r.released) released += 1
          await patchAccount(id, { status: 'active' })
        } catch { /* skip */ }
      }
      await loadAccounts()
      await loadAccountBusy()
      pushToast({ type: 'success', title: 'Остановлено/освобождено', desc: `Снято блокировок: ${released} из ${ids.length}` })
      setSelected(new Set())
    })()
  }

  const bulkMove = async (patch: { role?: string; project?: string }) => {
    // §3.2/§4: перенос профилей — подтверждение с последствиями + фиксация в аудите (initiator).
    const label = patch.role ? `роль → «${patch.role}»` : patch.project ? `проект → «${patch.project}»` : 'перенос'
    if (!(await confirmBulk(selected.size, `перенести (${label})`))) return
    void (async () => {
      const ids = [...selected]
      for (const id of ids) { try { await patchAccount(id, { ...patch, initiator: 'operator' }) } catch { /* skip */ } }
      await loadAccounts()
      pushToast({ type: 'success', title: 'Перемещено', desc: `Профилей: ${ids.length}` })
      setMoveOpen(false)
      setSelected(new Set())
    })()
  }

  const showCol = (k: string) => visibleCols.includes(k)
  const openAdd = () => { setWizardMode('add'); setReauthTarget(null); setAddOpen(true) }
  const openReauth = (a: TgAccount) => { setWizardMode('reauth'); setReauthTarget(a); setAddOpen(true) }
  const closeWizard = () => { setAddOpen(false); setReauthTarget(null) }

  return (
    <div>
      <PageHeader
        title="Менеджер аккаунтов"
        subtitle="Управление Telegram-аккаунтами, статусами и прокси"
        icon={<Users size={22} />}
        actions={
          <>
            <HelpButton topic="accounts-manager" className="h-10 w-10" />
            <AiSafetyModal />
            <button onClick={() => setImportOpen(true)} className="btn-ghost h-10"><UploadCloud size={16} /> <span className="hidden sm:inline">Импортировать</span></button>
            <button onClick={() => setProxyPoolOpen(true)} className="btn-ghost h-10"><Server size={16} /> <span className="hidden sm:inline">Пул прокси</span></button>
            <button
              onClick={() => (isNoSub ? pushToast({ type: 'error', title: 'Лимит тарифа', desc: 'Оформите подписку для добавления аккаунтов.' }) : openAdd())}
              className="btn-primary h-10"
            >
              <Plus size={16} /> Добавить аккаунт
            </button>
          </>
        }
      />

      {/* Status cards */}
      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7">
        {STATUS_ORDER.map((st) => {
          const m = STATUS_META[st]
          const activeCard = statusFilter === st
          return (
            <button
              key={st}
              onClick={() => { setStatusFilter(activeCard ? 'all' : st); setRiskFilter('all'); setPage(0); setTab('accounts') }}
              className={cn(
                'group/kpi relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all',
                activeCard ? 'border-spark-500/50 bg-spark-500/8 shadow-spark-glow' : 'border-line bg-surface hover:border-spark-500/30',
              )}
            >
              <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border', m.bg)}>
                <span className={cn('h-2 w-2 rounded-full', m.dot)} />
              </span>
              <div className="min-w-0">
                <div className="font-display text-xl font-bold text-fg">{statusCounts[st]}</div>
                <div className="truncate text-[11px] font-semibold text-muted">{m.label}</div>
              </div>
              <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-fg opacity-0 shadow-xl transition-opacity group-hover/kpi:opacity-100">{STATUS_TIP[st]}</span>
            </button>
          )
        })}
        {/* Правка 14.08: 3 причины риска (мёртвый прокси / нет прокси / низкое доверие) —
            карточками в верхнем ряду вместе со статусами (пока статусы не доработаны). */}
        {RISK_ORDER.map((rk) => {
          const m = RISK_META[rk]
          const activeCard = riskFilter === rk
          return (
            <button
              key={rk}
              onClick={() => { setRiskFilter(activeCard ? 'all' : rk); setStatusFilter('all'); setPage(0); setTab('accounts') }}
              className={cn(
                'group/kpi relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all',
                activeCard ? 'border-rose-500/50 bg-rose-500/8 shadow-spark-glow' : 'border-line bg-surface hover:border-rose-500/30',
              )}
            >
              <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border', m.bg)}>
                <span className={cn('h-2 w-2 rounded-full', m.dot)} />
              </span>
              <div className="min-w-0">
                <div className="font-display text-xl font-bold text-fg">{riskCounts[rk]}</div>
                <div className="truncate text-[11px] font-semibold text-muted">{m.label}</div>
              </div>
              <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-fg opacity-0 shadow-xl transition-opacity group-hover/kpi:opacity-100">{m.tip}</span>
            </button>
          )
        })}
        {/* Корзина — тоже карточкой в верхнем ряду: аккаунты, отправленные в корзину. */}
        <button
          onClick={() => { setTab(tab === 'trash' ? 'accounts' : 'trash'); setStatusFilter('all'); setRiskFilter('all'); setPage(0); setSelected(new Set()) }}
          className={cn(
            'group/kpi relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all',
            tab === 'trash' ? 'border-spark-500/50 bg-spark-500/8 shadow-spark-glow' : 'border-line bg-surface hover:border-spark-500/30',
          )}
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-500/30 bg-slate-500/12 text-slate-300">
            <Trash2 size={15} />
          </span>
          <div className="min-w-0">
            <div className="font-display text-xl font-bold text-fg">{trashed.length}</div>
            <div className="truncate text-[11px] font-semibold text-muted">Корзина</div>
          </div>
          <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-fg opacity-0 shadow-xl transition-opacity group-hover/kpi:opacity-100">Аккаунты, отправленные в корзину. Клик — открыть/закрыть.</span>
        </button>
      </div>

      {/* (8) Сводка по модулям */}
      {moduleSummary.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-faint">В работе по модулям:</span>
          <button
            onClick={() => { setModuleFilter('all'); setPage(0) }}
            className={cn('rounded-lg border px-2.5 py-1 text-xs font-semibold', moduleFilter === 'all' ? 'border-spark-500/50 bg-spark-500/8 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}
          >
            Все
          </button>
          {moduleSummary.map((m) => (
            <button
              key={m.key}
              onClick={() => { setModuleFilter(m.key); setPage(0) }}
              className={cn('rounded-lg border px-2.5 py-1 text-xs font-semibold', moduleFilter === m.key ? 'border-spark-500/50 bg-spark-500/8 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}
            >
              {m.label} <span className="opacity-70">{m.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar (правка 14.08: без таба «Аккаунты/Корзина», без «Колонки»; сортировка — в фильтрах;
          «Обновить» и «Удалённые» — иконками справа). */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} className="input pl-9" placeholder="Поиск по имени, @username, номеру…" />
        </div>

        {/* Filters dropdown */}
        <Dropdown
          width={260}
          trigger={({ toggle, open }) => (
            <button onClick={toggle} className={cn('btn-ghost h-10', (roleFilter !== 'Все роли' || countryFilter !== 'all' || riskFilter !== 'all' || open) && 'border-spark-500/40 text-spark-300')}>
              <Filter size={16} /> <span className="hidden sm:inline">Фильтры</span>
            </button>
          )}
        >
          {() => (
            <div className="p-1.5">
              {/* Правка 14.08: сортировка («Свободные сверху» и др.) — внутри фильтров. */}
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Сортировка</div>
              <Select
                className="mb-3"
                value={sortKey}
                onChange={(v) => { setSortKey(v as SortKey); setPage(0) }}
                options={SORT_LABELS.map((s) => ({ value: s.key, label: s.label }))}
              />
              {/* Правка 14.08: фильтр «Кампания» скрыт в менеджере (кампаний пока нет). */}
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Страна</div>
              <Select className="mb-3" value={countryFilter} onChange={setCountryFilter} options={countryOptionsFrom(active.map((a) => a.country)).map((c) => ({ value: c.code, label: `${c.flag} ${c.label}`.trim() }))} />
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Модуль</div>
              <Select
                value={moduleFilter}
                onChange={(v) => { setModuleFilter(v); setPage(0) }}
                options={[
                  { value: 'all', label: 'Все модули' },
                  { value: 'idle', label: 'Свободные (не в работе)' },
                  ...moduleSummary.map((m) => ({ value: m.key, label: `${m.label} (${m.count})` })),
                ]}
              />
              {/* §4 (D2): фильтр по усталости — ползунок, вместо «Проекта». */}
              <div className="mb-1 mt-3 flex items-center justify-between px-1 text-[11px] font-bold uppercase tracking-wide text-faint">
                <span>Усталость</span>
                <span className="text-spark-300">{fatigueMin > 0 ? `≥ ${fatigueMin}%` : 'любая'}</span>
              </div>
              <input
                type="range" min={0} max={100} step={5} value={fatigueMin}
                onChange={(e) => { setFatigueMin(Number(e.target.value) || 0); setPage(0) }}
                className="w-full accent-spark-500"
              />
              <button onClick={() => { setRoleFilter('Все роли'); setCountryFilter('all'); setModuleFilter('all'); setFatigueMin(0); setRiskFilter('all'); setSortKey('default') }} className="btn-ghost mt-3 h-8 w-full text-xs">Сбросить фильтры</button>
            </div>
          )}
        </Dropdown>

        {/* Правки 14.08: «Задачи» и «Обновить» — иконками справа. «Корзина/Удалённые» теперь
            отдельной карточкой в верхнем ряду статусов. */}
        <div className="ml-auto flex items-center gap-2">
          <IconBtn icon={<ListChecks size={17} />} label="Задачи" onClick={() => setTasksOpen(true)} />
          <IconBtn icon={<RefreshCw size={17} />} label="Обновить список" onClick={() => { void loadAccounts(); pushToast({ type: 'info', title: 'Обновлено', desc: 'Список загружен с сервера.' }) }} />
          {tab === 'trash' && trashed.length > 0 && (
            <button onClick={() => { void emptyTrash().then(() => pushToast({ type: 'success', title: 'Корзина очищена' })) }} className="btn-danger h-10"><Trash2 size={16} /> Очистить</button>
          )}
        </div>
      </div>

      {/* §2: корзина — массовое восстановление и фильтр «живых» (валидных) сессий. */}
      {tab === 'trash' && trashed.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 px-3 py-2">
          <button
            disabled={selected.size === 0}
            onClick={() => { void bulkRestore() }}
            className={cn('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors',
              selected.size ? 'border-spark-500/50 bg-spark-500/12 text-spark-300 hover:bg-spark-500/20' : 'border-line text-white/25')}
          >
            <Undo2 size={14} /> Восстановить выбранные{selected.size ? ` (${selected.size})` : ''}
          </button>
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-white/60">
            <input type="checkbox" checked={trashAlive} onChange={(e) => setTrashAlive(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
            Только «живые» (валидные сессии)
          </label>
        </div>
      )}

      {/* Панель управления выбранными — всегда видна на вкладке аккаунтов; серая, если ничего не выбрано */}
      {tab === 'accounts' && (() => {
        const has = selected.size > 0
        const total = active.length
        const spamIds = active.filter((a) => a.status === 'spamblock').map((a) => a.id)
        return (
        // Правки 14.08: панель управления целиком в иконках + кастомные тултипы; счётчик «N из total».
        <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-elevated/40 px-3 py-2">
          <span className={`mr-1 text-sm font-bold tabular-nums ${has ? 'text-spark-300' : 'text-white/40'}`}>{selected.size} из {total}</span>
          <IconBtn disabled={!has} icon={<Play size={16} />} label="Запустить" onClick={() => bulkStatusManual('active', 'Включено')} tone="border-spark-500/50 bg-spark-500/12 text-spark-300 hover:bg-spark-500/20" />
          <IconBtn disabled={!has} icon={<Pause size={16} />} label="Пауза" onClick={() => bulkStatusManual('pause', 'На паузе')} tone="border-amber-500/50 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20" />
          <IconBtn disabled={!has} icon={<Square size={15} />} label="Стоп / освободить" onClick={bulkRelease} tone="border-rose-500/50 bg-rose-500/12 text-rose-300 hover:bg-rose-500/20" />
          <IconBtn disabled={!has} icon={<Power size={16} />} label="Отключить (frozen)" onClick={() => bulkSetStatus('frozen', 'Отключено (frozen)')} tone="border-rose-500/40 bg-rose-500/8 text-rose-300 hover:bg-rose-500/15" />
          <span className="mx-1 h-5 w-px bg-line" />
          <IconBtn disabled={!has} icon={<Users size={16} />} label="Переместить" onClick={() => setMoveOpen(true)} />
          {/* §4.5: массово задать усталость/отдых, «как живой человек». */}
          <IconBtn disabled={!has} icon={<Moon size={16} />} label="Усталость и отдых" onClick={() => setFatigueOpen(true)} />
          {/* Снятие спамблока через @SpamBot — массово, с рандомными задержками. */}
          <IconBtn disabled={!spamIds.length} icon={<ShieldCheck size={16} />} label={`Снять спамблок${spamIds.length ? ` (${spamIds.length})` : ''}`} onClick={() => setUnblockOpen(true)} tone="border-amber-500/40 bg-amber-500/8 text-amber-300 hover:bg-amber-500/15" />
          <IconBtn disabled={!has} icon={<Server size={16} />} label="Назначить прокси" onClick={() => setAssignProxyOpen(true)} />
          <IconBtn disabled={!has} icon={<KeyRound size={16} />} label="Реавторизация" onClick={() => { void (async () => { for (const id of selected) await setAccountStatus(id, 'reauth'); pushToast({ type: 'info', title: 'Отправлено на реавторизацию' }); setSelected(new Set()) })() }} />
          {/* «Управление» — мульти-просмотр выбранных: открываем обзор на первом, весь выбор в ?sel=. */}
          <IconBtn disabled={!has} icon={<Eye size={16} />} label="Управление (обзор выбранных)" onClick={() => { const chosen = active.filter((a) => selected.has(a.id)); if (!chosen.length) return; navigate(`/panel/accounts/${chosen[0].id}?sel=${chosen.map((a) => a.id).join(',')}`) }} tone="border-iris-500/50 bg-iris-500/12 text-iris-200 hover:bg-iris-500/20" />
          {/* «В корзину» — деструктивная, крайняя справа. */}
          <span className="ml-auto inline-flex">
            <IconBtn disabled={!has} icon={<Trash2 size={16} />} label={busySelected.length ? `В корзину — сначала остановите ${busySelected.length} в работе` : 'В корзину'} onClick={bulkTrash} tone="border-line text-fg hover:bg-elevated" />
          </span>
        </div>
        )
      })()}

      {/* Table / content */}
      {isNoSub ? (
        <PaywallLock>
          <AccountsTable pageItems={active.slice(0, 3)} visibleCols={visibleCols} showCol={showCol} selected={selected} toggleOne={() => {}} allOnPageSelected={false} someOnPageSelected={false} toggleAll={() => {}} tab="accounts" onDetail={() => {}} onProxy={() => {}} onTrash={() => {}} onRestore={() => {}} onReauth={() => {}} onMarkReauth={() => {}} loading={false} campaignOf={campaignOf} onAssign={() => {}} />
        </PaywallLock>
      ) : loading ? (
        <div className="card overflow-hidden p-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line/60 px-4 py-3.5 last:border-0">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Users size={26} />}
            title={tab === 'trash' ? 'Корзина пуста' : query || roleFilter !== 'Все роли' || statusFilter !== 'all' ? 'Ничего не найдено' : 'Пока нет аккаунтов'}
            desc={tab === 'trash' ? 'Удалённые аккаунты появятся здесь.' : query ? 'Измените параметры поиска или фильтры.' : 'Добавьте аккаунт по номеру или импортируйте сессии.'}
            action={tab === 'accounts' && !query && statusFilter === 'all' ? (
              <div className="flex gap-2">
                <button onClick={() => setImportOpen(true)} className="btn-ghost h-10"><UploadCloud size={16} /> Импорт</button>
                <button onClick={openAdd} className="btn-primary h-10"><Plus size={16} /> Добавить аккаунт</button>
              </div>
            ) : undefined}
          />
        </div>
      ) : (
        <>
          <AccountsTable
            campaignOf={campaignOf}
            onAssign={setAssignAcc}
            proxyName={proxyName}
            pageItems={pageItems}
            visibleCols={visibleCols}
            showCol={showCol}
            selected={selected}
            toggleOne={toggleOne}
            allOnPageSelected={allOnPageSelected}
            someOnPageSelected={someOnPageSelected}
            toggleAll={toggleAll}
            tab={tab}
            onDetail={(a) => navigate(`/panel/accounts/${a.id}`)}
            onProxy={setProxyAcc}
            onTrash={(a) => { void trashAccount(a.id).then(() => pushToast({ type: 'success', title: 'В корзину', desc: a.name })) }}
            onRestore={(a) => { void restoreAccount(a.id).then(() => pushToast({ type: 'success', title: 'Восстановлено', desc: a.name })) }}
            onReauth={openReauth}
            onMarkReauth={(a) => { void setAccountStatus(a.id, 'reauth').then(() => pushToast({ type: 'info', title: 'Требуется реавторизация', desc: a.name })) }}
            loading={false}
            dailyAll={dailyAll}
            activity={activity}
            onSetFatigue={setFatigueOne}
          />

          {/* Pagination */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted">
              <span>Показано {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} из {filtered.length}</span>
              <Select
                className="w-24"
                value={String(pageSize)}
                onChange={(v) => { setPageSize(Number(v)); setPage(0) }}
                options={[10, 25, 50, 100].map((n) => ({ value: String(n), label: `${n} / стр` }))}
              />
            </div>
            <div className="flex items-center gap-1">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="btn-ghost h-9 px-3 disabled:opacity-40">Назад</button>
              {Array.from({ length: pageCount }).map((_, i) => (
                <button key={i} onClick={() => setPage(i)} className={cn('h-9 w-9 rounded-lg text-sm font-semibold', i === page ? 'bg-spark-gradient text-[#04150c]' : 'border border-line bg-elevated text-muted hover:text-fg')}>{i + 1}</button>
              ))}
              <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="btn-ghost h-9 px-3 disabled:opacity-40">Вперёд</button>
            </div>
          </div>
        </>
      )}

      {/* Modals */}
      <AddAccountWizard open={addOpen} onClose={closeWizard} mode={wizardMode} account={reauthTarget} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={() => void loadAccounts()} />
      <ProxyPoolModal open={proxyPoolOpen} onClose={() => setProxyPoolOpen(false)} />

      {/* Account Management (реальная статистика) */}
      <AccountManagementModal account={detailAcc} onClose={() => setDetailAcc(null)} />

      {/* Change proxy */}
      <AssignCampaignModal
        acc={assignAcc}
        campaigns={campaigns}
        current={assignAcc ? campaignOf(assignAcc.id) : null}
        onClose={() => setAssignAcc(null)}
        onApply={(cid, lock) => { void assignToCampaign(assignAcc!.id, cid, lock) }}
      />
      <ChangeProxyModal acc={proxyAcc} onClose={() => setProxyAcc(null)} onSave={(id, p) => { void setAccountProxy(id, p).then(() => { pushToast({ type: 'success', title: 'Прокси обновлён' }); setProxyAcc(null) }) }} />

      {/* (8) Bulk move to group */}
      <BulkMoveModal open={moveOpen} count={selected.size} onClose={() => setMoveOpen(false)} onApply={bulkMove} />
      <FatigueModal
        open={fatigueOpen || !!fatigueOne}
        ids={fatigueOne ? [fatigueOne] : [...selected]}
        activity={activity}
        onClose={() => { setFatigueOpen(false); setFatigueOne(null) }}
        onDone={(map, msg) => { setActivityMap(map); setFatigueOpen(false); setFatigueOne(null); if (!fatigueOne) setSelected(new Set()); pushToast({ type: 'success', title: msg }) }}
        onError={(e) => pushToast({ type: 'error', title: 'Не применилось', desc: e })}
      />
      <UnblockModal
        open={unblockOpen}
        ids={(() => {
          const sel = active.filter((a) => selected.has(a.id) && a.status === 'spamblock').map((a) => a.id)
          return sel.length ? sel : active.filter((a) => a.status === 'spamblock').map((a) => a.id)
        })()}
        names={Object.fromEntries(active.map((a) => [a.id, a.name || a.username || a.phone || a.id.slice(-6)]))}
        onClose={() => setUnblockOpen(false)}
        onFinished={() => { void loadAccounts() }}
        pushToast={pushToast}
      />
      <AssignProxyModal
        open={assignProxyOpen}
        ids={[...selected]}
        onClose={() => setAssignProxyOpen(false)}
        onDone={(msg) => { setAssignProxyOpen(false); setSelected(new Set()); void loadAccounts(); pushToast({ type: 'success', title: msg }) }}
        onError={(e) => pushToast({ type: 'error', title: 'Не применилось', desc: e })}
      />
    </div>
  )
}

/**
 * Массовая привязка прокси к уже залитым аккаунтам.
 *
 * При импорте прокси раздаются сразу — а дальше сценарий обрывался: пул умер, купили
 * новый, аккаунты переехали между проектами, и всё это правится по одному в карточке.
 * Режимы те же, что в импорте, и раздача идёт той же серверной функцией, чтобы правило
 * «один прокси — один аккаунт» жило в одном месте.
 */
function AssignProxyModal({ open, ids, onClose, onDone, onError }: {
  open: boolean
  ids: string[]
  onClose: () => void
  onDone: (message: string) => void
  onError: (e: string) => void
}) {
  const [mode, setMode] = useState<'pool' | 'single' | 'none'>('pool')
  const [proxies, setProxies] = useState<ApiProxy[]>([])
  const [free, setFree] = useState(0)
  const [single, setSingle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    // Нерабочие в выбор не предлагаем — см. isUsableProxy.
    void fetchProxies().then((list) => setProxies(list.filter(isUsableProxy))).catch(() => {})
    void proxyCapacity().then((c) => setFree(c.free)).catch(() => {})
  }, [open])

  // Свободными считаем и те, что уже висят на выбранных: перепривязка той же пачки
  // на тот же пул иначе упиралась бы в «не хватило прокси».
  const notEnough = mode === 'pool' && ids.length > free

  const apply = async () => {
    setBusy(true)
    try {
      const r = await assignProxies({ accountIds: ids, mode, singleProxy: single })
      const failed = r.rows.filter((x) => !x.ok).length
      onDone(failed
        ? `Назначено ${r.applied} акк., не хватило прокси для ${failed}`
        : `Прокси назначены: ${r.applied} акк.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Назначить прокси"
      subtitle={`Выбрано аккаунтов: ${ids.length}`}
      icon={<Server size={22} />}
      size="sm"
      footer={<button onClick={onClose} className="btn-ghost h-10">Закрыть</button>}
    >
      <label className="label">Как раздать</label>
      <Select
        value={mode}
        onChange={(v) => setMode(v as typeof mode)}
        options={[
          { value: 'pool', label: 'По одному из пула на аккаунт' },
          { value: 'single', label: 'Один прокси на всю пачку' },
          { value: 'none', label: 'Снять прокси (прямое подключение)' },
        ]}
      />

      {mode === 'pool' && (
        <p className={cn('mt-2 text-xs', notEnough ? 'text-amber-300' : 'text-white/45')}>
          Свободно прокси: {free}. {notEnough
            ? `Выбрано ${ids.length} — на всех не хватит, остальные останутся как есть.`
            : 'Один прокси — один аккаунт.'}
        </p>
      )}

      {mode === 'none' && (
        // Снять прокси можно — это законный сценарий. Но последствие должно быть
        // на экране до нажатия, а не выясняться по спамблокам через сутки.
        <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/8 p-3">
          <div className="flex items-center gap-1.5 text-sm font-bold text-rose-300">
            <AlertTriangle size={14} /> Высокий риск блокировки
          </div>
          <p className="mt-1 text-xs leading-relaxed text-rose-200/70">
            {ids.length} аккаунт(ов) пойдут через ваш IP — тот же, что у остальных без прокси.
            Для Telegram это одна группа: находит один аккаунт, изучает параметры и добивает
            похожие с того же адреса. Работать так можно, но живут они заметно меньше.
          </p>
        </div>
      )}

      {mode === 'single' && (
        <>
          <label className="label mt-3">Прокси</label>
          <Select
            value={single}
            onChange={setSingle}
            options={proxies.map((p) => ({ value: toProxyUrl(p), label: `${p.label || p.host}:${p.port}` }))}
          />
          <p className="mt-2 text-xs text-amber-300/80">
            Вся пачка выйдет с одного IP — Telegram видит такую группу и банит волной.
            Осознанный выбор, но не для больших пачек.
          </p>
        </>
      )}

      <button
        disabled={busy || !ids.length || (mode === 'single' && !single)}
        onClick={() => void apply()}
        className="btn-primary mt-4 h-10 w-full disabled:opacity-40"
      >
        Применить к выбранным
      </button>
    </Modal>
  )
}

function BulkMoveModal({ open, count, onClose, onApply }: {
  open: boolean; count: number; onClose: () => void; onApply: (patch: { role?: string; project?: string }) => void
}) {
  const [role, setRole] = useState('')
  const [project, setProject] = useState('')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Переместить в группу"
      subtitle={`Выбрано аккаунтов: ${count}`}
      icon={<Users size={22} />}
      size="sm"
      footer={<>
        <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
        <button
          onClick={() => onApply({ ...(role ? { role } : {}), ...(project.trim() ? { project: project.trim() } : {}) })}
          disabled={!role && !project.trim()}
          className="btn-primary h-10 disabled:opacity-40"
        >
          Применить
        </button>
      </>}
    >
      <label className="label">Роль</label>
      <Select
        className="mb-3"
        value={role}
        onChange={setRole}
        options={[{ value: '', label: '— не менять —' }, ...ROLES.filter((r) => r !== 'Все роли').map((r) => ({ value: r, label: r }))]}
      />
      <label className="label">Проект / папка</label>
      <input value={project} onChange={(e) => setProject(e.target.value)} className="input" placeholder="Например: crypto_batch (пусто = не менять)" />
    </Modal>
  )
}

/* ── Table subcomponent ── */
function AccountsTable(props: {
  pageItems: TgAccount[]
  visibleCols: string[]
  showCol: (k: string) => boolean
  selected: Set<string>
  toggleOne: (id: string) => void
  allOnPageSelected: boolean
  someOnPageSelected: boolean
  toggleAll: () => void
  tab: 'accounts' | 'trash'
  onDetail: (a: TgAccount) => void
  onProxy: (a: TgAccount) => void
  onTrash: (a: TgAccount) => void
  onRestore: (a: TgAccount) => void
  onReauth: (a: TgAccount) => void
  onMarkReauth: (a: TgAccount) => void
  loading: boolean
  dailyAll?: DailyAllMap
  /** §4: усталость/отдых — общая для всех модулей (D1). */
  activity?: ActivityMap
  /** §4 (D2): задать усталость ОДНОМУ аккаунту (клик по ячейке усталости). */
  onSetFatigue?: (id: string) => void
  /** §1: под какой кампанией аккаунт и закреплён ли (замочек). */
  campaignOf: (accountId: string) => { name: string; locked: boolean } | null
  onAssign: (a: TgAccount) => void
  proxyName?: (url: string) => string
}) {
  const { pageItems, showCol, selected, toggleOne, allOnPageSelected, toggleAll, campaignOf } = props
  const showAccountCol = showCol('name') || showCol('avatar')
  return (
    <div className="card overflow-hidden p-0">
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-elevated/60 text-left text-[11px] font-bold uppercase tracking-wide text-muted">
              <th className="w-10 px-4 py-3">
                <TriStateCheckbox
                  checked={allOnPageSelected}
                  indeterminate={props.someOnPageSelected}
                  onChange={toggleAll}
                  title={props.someOnPageSelected ? 'Выбрано частично — клик снимет весь выбор' : allOnPageSelected ? 'Снять выбор' : 'Выбрать все на странице'}
                />
              </th>
              {showAccountCol && <th className="px-4 py-3">Аккаунт</th>}
              {showCol('campaign') && <th className="px-4 py-3">Кампания</th>}
              {showCol('fatigue') && <th className="px-4 py-3">Усталость</th>}
              {showCol('status') && (
                <th className="px-4 py-3">
                  <span className="inline-flex items-center gap-1">
                    Статус
                    {/* Правка 14.08: кастомная плавающая подсказка (как в блоке «Защита»), не нативный title. */}
                    <span className="group/sh relative grid h-4 w-4 cursor-help place-items-center rounded-full border border-line text-[10px] font-bold text-muted">
                      ?
                      <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-50 w-[340px] -translate-x-1/2 whitespace-pre-line rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[11px] font-normal normal-case leading-relaxed text-muted opacity-0 shadow-xl transition-opacity group-hover/sh:opacity-100">{STATUS_HELP}</span>
                    </span>
                  </span>
                </th>
              )}
              {showCol('lastSeen') && <th className="px-4 py-3">Отлёжка</th>}
              {showCol('proxy') && <th className="px-4 py-3">Прокси</th>}
              <th className="px-4 py-3 text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((a) => (
              <tr key={a.id} className={cn('border-b border-line/50 transition-colors last:border-0 hover:bg-elevated/40', selected.has(a.id) && 'bg-spark-500/5', a.busyIn && 'opacity-60')}>
                <td className="px-4 py-3"><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} className="h-4 w-4 rounded border-line accent-spark-500" /></td>
                {showAccountCol && (
                <td className="px-4 py-3">
                  <Tip text="Открыть статистику аккаунта" className="!flex min-w-0 max-w-full">
                    <button type="button" onClick={() => props.onDetail(a)} className="group flex min-w-0 items-center gap-3 text-left">
                      {showCol('avatar') && <Avatar name={accountLabel(a)} color={a.avatarColor} />}
                      <div className="min-w-0">
                        {showCol('name') && <div className="truncate font-semibold text-fg transition-colors group-hover:text-spark-300">{accountLabel(a)}</div>}
                        <div className="truncate text-xs text-muted">{accountSub(a)}</div>
                      </div>
                    </button>
                  </Tip>
                </td>
                )}
                {showCol('campaign') && (
                  <td className="px-4 py-3">
                    {(() => {
                      const c = campaignOf(a.id)
                      if (!c) return <span className="text-xs text-faint">в общем пуле</span>
                      return (
                        // Два состояния различались ТОЛЬКО формой иконки в 11px (закрытый
                        // янтарный замок против открытого серого) — тестировщик не смог
                        // отличить их даже на скриншоте. Добавляем словесную подпись:
                        // от неё зависит, уйдёт аккаунт в другую кампанию или нет (тест 3.3).
                        <Tip className="items-center gap-1 text-xs text-fg" text={c.locked ? `Закреплён за кампанией «${c.name}» — вышел из общего пула` : `Используется кампанией «${c.name}» без закрепления — остаётся доступен другим`}>
                          {c.locked ? <Lock size={11} className="shrink-0 text-amber-300" /> : <LockOpen size={11} className="shrink-0 text-faint" />}
                          <span className="truncate">{c.name}</span>
                          <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-bold ${c.locked ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-faint'}`}>
                            {c.locked ? 'закреплён' : 'без лока'}
                          </span>
                        </Tip>
                      )
                    })()}
                  </td>
                )}
                {showCol('fatigue') && (() => {
                  const act = props.activity?.[a.id]
                  const th = act?.threshold ?? 0
                  const pct = act && th > 0 ? Math.min(100, Math.round((act.fatigue / th) * 100)) : 0
                  const resting = act?.resting
                  const tone = resting ? 'bg-iris-400' : pct >= 70 ? 'bg-rose-400' : pct >= 40 ? 'bg-amber-400' : 'bg-spark-500'
                  return (
                    <td className="px-4 py-3">
                      {/* MR-129: «0/15» читалось непонятно. Поясняем в кастомном тултипе (MR-162):
                          «сделано действий / порог» (осталось = порог − сделано). */}
                      <Tip
                        className="!flex w-28"
                        text={th > 0
                          ? `Усталость: сделано ${act?.fatigue ?? 0} из ${th} действий до отдыха (осталось ${Math.max(0, th - (act?.fatigue ?? 0))}). На пороге аккаунт отдыхает во всех модулях. Клик — задать порог и распорядок.`
                          : 'Задать усталость и распорядок этому аккаунту'}
                      >
                        <button
                          type="button"
                          onClick={() => props.onSetFatigue?.(a.id)}
                          className="flex w-full items-center gap-2 text-left"
                        >
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                            <span className={cn('block h-full rounded-full transition-all', tone)} style={{ width: `${pct}%` }} />
                          </span>
                          <span className="w-14 shrink-0 text-[11px] tabular-nums text-muted">
                            {resting ? 'отдых' : th > 0 ? `${act?.fatigue ?? 0}/${th}` : '—'}
                          </span>
                        </button>
                      </Tip>
                    </td>
                  )
                })()}
                {showCol('status') && (
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      {/* MR-131: при мёртвом/отсутствующем прокси НЕ показываем «Активный» — вместо него
                      бейдж «Зона риска» с конкретикой; иначе статус + риск-бейдж рядом. */}
                  {a.status === 'active' && a.risk?.proxyIssue ? (
                    <RiskChip a={a} />
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={a.status} until={a.statusUntil} reason={a.statusReason} />
                      {a.risk && a.risk.level !== 'none' && <RiskChip a={a} />}
                    </span>
                  )}
                      {a.busyIn ? (
                        a.busyIn.taskStatus === 'paused' ? (
                          <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-300">
                            <Pause size={11} /> На паузе: {a.busyIn.moduleLabel}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-[11px] font-semibold text-spark-300">
                            <Loader2 size={11} className="animate-spin" /> В работе: {a.busyIn.moduleLabel}
                          </div>
                        )
                      ) : a.status === 'pause' ? (
                        <Tip text="Аккаунт поставлен на паузу оператором, а не задачей модуля" className="items-center gap-1 text-[11px] font-semibold text-amber-300/70">
                          <Pause size={11} /> Пауза вручную · не в модуле
                        </Tip>
                      ) : null}
                      {/* §2: score виден ВСЕГДА (не только у проблемных) + подсказка, где можно/нельзя. */}
                      {typeof a.trustScore === 'number' && (
                        <Tip text={a.trustBand === 'low'
                          ? `Trust ${a.trustScore} (<40): в боевые модули не берётся — нужен прогрев. Мейлинг недоступен (нужен trust>70).`
                          : a.trustBand === 'high'
                            ? `Trust ${a.trustScore} (>70): доступны все модули, включая мейлинг.`
                            : `Trust ${a.trustScore} (40–70): боевые модули только на «Консервативном» уровне; мейлинг недоступен (нужен trust>70).`}>
                          <span
                            className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                              a.trustBand === 'low' ? 'bg-rose-500/15 text-rose-300'
                                : a.trustBand === 'high' ? 'bg-spark-500/15 text-spark-300'
                                  : 'bg-amber-500/15 text-amber-300')}
                          >
                            Доверие {a.trustScore}
                            {a.trustBand === 'low' ? ' · прогрев' : a.trustBand !== 'high' ? ' · без мейлинга' : ''}
                          </span>
                        </Tip>
                      )}
                      {(() => {
                        const d = props.dailyAll?.[a.id]
                        if (!d) return null
                        if (d.anyReached) {
                          const hit = d.items.filter((x) => x.reached).map((x) => DAILY_CAP_LABELS[x.action] ?? x.action).join(', ')
                          return (
                            <Tip text={`Суточный лимит достигнут: ${hit}. Модули пропускают аккаунт до сброса в полночь.`}>
                              <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">Лимит: {hit}</span>
                            </Tip>
                          )
                        }
                        // Раннее предупреждение: ≥75% любого потолка, но ещё не заблокирован.
                        const near = d.items.filter((x) => x.cap > 0 && !x.reached && x.used / x.cap >= 0.75)
                        if (near.length) {
                          const lbl = near.map((x) => `${DAILY_CAP_LABELS[x.action] ?? x.action} ${x.used}/${x.cap}`).join(', ')
                          return (
                            <Tip text={`Близко к суточному лимиту: ${lbl}. Скоро модули начнут пропускать аккаунт.`}>
                              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">Близко: {near.map((x) => DAILY_CAP_LABELS[x.action] ?? x.action).join(', ')}</span>
                            </Tip>
                          )
                        }
                        return null
                      })()}
                      {/* §4: усталость видна прямо в списке — иначе оператор раздаст задачи
                          профилям, которые сейчас «отдыхают», и узнает об этом из логов. */}
                      {(() => {
                        const act = props.activity?.[a.id]
                        if (!act) return null
                        if (act.resting) {
                          const left = Math.ceil((act.restUntil - Date.now()) / 60000)
                          return (
                            <Tip text={`Аккаунт отдыхает после нагрузки — освободится через ${left} мин. Отдых общий для всех модулей.`}>
                              <span className="rounded-md bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">отдыхает {left > 0 ? `${left} мин` : ''}</span>
                            </Tip>
                          )
                        }
                        if (act.threshold > 0 && act.fatigue / act.threshold >= 0.7) {
                          return (
                            <Tip text={`Усталость ${act.fatigue} из ${act.threshold} — скоро уйдёт на отдых во всех модулях.`}>
                              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">устаёт {act.fatigue}/{act.threshold}</span>
                            </Tip>
                          )
                        }
                        // §4.2: низкий шанс часа — самая частая причина «модуль ничего
                        // не делает». Без этой метки её ищут в логах задачи.
                        if (typeof act.chanceNow === 'number' && act.chanceNow < 20 && (a.proxy && a.proxy !== '—')) {
                          // MR-129: не пишем явным текстом — только тихая иконка часов с подсказкой.
                          return (
                            <Tip
                              className="items-center text-white/35"
                              text={`Тихий час по распорядку: сейчас шанс действия ${act.chanceNow}% — аккаунт чаще всего будет пропущен. Меняется в «Усталость и отдых».`}
                            >
                              <Clock size={12} />
                            </Tip>
                          )
                        }
                        return null
                      })()}
                      {/* Колонку «Прокси» можно скрыть в настройках таблицы — риск скрывать нельзя. */}
                      {!hasProxy(a) && !showCol('proxy') && (
                        <Tip
                          className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-300"
                          text="Аккаунт ходит через ваш IP — тот же, что у остальных без прокси. Для Telegram это одна группа."
                        >
                          без прокси · риск блока
                        </Tip>
                      )}
                      {a.status === 'reauth' && props.tab === 'accounts' && (
                        <button type="button" onClick={() => props.onReauth(a)} className="text-xs font-semibold text-violet-300 hover:text-violet-200">
                          Войти снова →
                        </button>
                      )}
                    </div>
                  </td>
                )}
                {showCol('lastSeen') && <td className="px-4 py-3 text-muted">{a.lastSeen}</td>}
                {showCol('proxy') && (
                  // MR-129: прокси задаётся прямо из списка — клик по ячейке открывает «Сменить прокси».
                  // Плюс состояние: нет прокси / прокси не отвечает (помечен нерабочим в каталоге) —
                  // раньше в таблице всё выглядело исправным, а работа молча падала.
                  <td className="px-4 py-3 font-mono text-xs">
                    {/* MR-162/MR-169: один кастомный тултип на ячейку. У рабочего прокси в подсказке —
                        полный адрес (в строке показываем только название), у проблемного — что делать. */}
                    <Tip text={!hasProxy(a)
                      ? 'Аккаунт ходит через ваш IP — тот же, что у остальных без прокси. Для Telegram это одна группа: находит один аккаунт и добивает похожие. Нажмите, чтобы назначить прокси.'
                      : a.proxyOk === false
                        ? 'Прокси не отвечает и помечен нерабочим в каталоге. Нажмите, чтобы назначить живой — иначе задачи будут падать.'
                        : `${a.proxy} — нажмите, чтобы сменить`}>
                      <button
                        type="button"
                        onClick={() => props.onProxy(a)}
                        className="group/px inline-flex items-center gap-1.5 text-left transition-colors hover:text-spark-300"
                      >
                        {!hasProxy(a) ? (
                          <span className="inline-flex items-center gap-1 font-bold text-rose-300">
                            <AlertTriangle size={11} className="shrink-0" /> нет прокси · назначить
                          </span>
                        ) : a.proxyOk === false ? (
                          <span className="inline-flex items-center gap-1 font-bold text-rose-300">
                            <AlertTriangle size={11} className="shrink-0" /> прокси не отвечает · сменить
                          </span>
                        ) : (
                          <span className="text-muted group-hover/px:text-spark-300">{props.proxyName ? props.proxyName(a.proxy) : formatProxyLabel(a.proxy)}</span>
                        )}
                        <Server size={11} className="shrink-0 opacity-0 transition-opacity group-hover/px:opacity-100" />
                      </button>
                    </Tip>
                  </td>
                )}
                <td className="px-4 py-3 text-right">
                  <RowMenu a={a} {...props} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="divide-y divide-line/60 md:hidden">
        {pageItems.map((a) => (
          <div key={a.id} className={cn('flex items-center gap-3 p-3.5', a.busyIn && 'opacity-60')}>
            <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} className="h-4 w-4 rounded border-line accent-spark-500" />
            <Tip text="Открыть статистику аккаунта" className="!flex min-w-0 flex-1">
            <button type="button" onClick={() => props.onDetail(a)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <Avatar name={accountLabel(a)} color={a.avatarColor} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-fg">{accountLabel(a)}</div>
                <div className="truncate text-xs text-muted">{accountSub(a)}</div>
                <div className="mt-1.5">
                  {/* MR-131: при мёртвом/отсутствующем прокси НЕ показываем «Активный» — вместо него
                      бейдж «Зона риска» с конкретикой; иначе статус + риск-бейдж рядом. */}
                  {a.status === 'active' && a.risk?.proxyIssue ? (
                    <RiskChip a={a} />
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={a.status} until={a.statusUntil} reason={a.statusReason} />
                      {a.risk && a.risk.level !== 'none' && <RiskChip a={a} />}
                    </span>
                  )}
                {a.busyIn ? (
                  a.busyIn.taskStatus === 'paused' ? (
                    <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-300">
                      <Pause size={11} /> На паузе: {a.busyIn.moduleLabel}
                    </div>
                  ) : (
                    <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-spark-300">
                      <Loader2 size={11} className="animate-spin" /> В работе: {a.busyIn.moduleLabel}
                    </div>
                  )
                ) : a.status === 'pause' ? (
                  <Tip className="mt-1 items-center gap-1 text-[11px] font-semibold text-amber-300/70" text="Аккаунт поставлен на паузу оператором, а не задачей модуля">
                    <Pause size={11} /> Пауза вручную · не в модуле
                  </Tip>
                ) : null}
                </div>
              </div>
            </button>
            </Tip>
            <RowMenu a={a} {...props} />
          </div>
        ))}
      </div>
    </div>
  )
}

function RowMenu({ a, tab, onDetail, onProxy, onTrash, onRestore, onReauth, onMarkReauth, onAssign }: {
  a: TgAccount; tab: 'accounts' | 'trash'
  onDetail: (a: TgAccount) => void; onProxy: (a: TgAccount) => void
  onTrash: (a: TgAccount) => void; onRestore: (a: TgAccount) => void
  onReauth: (a: TgAccount) => void; onMarkReauth: (a: TgAccount) => void
  onAssign: (a: TgAccount) => void
}) {
  return (
    <Dropdown
      width={210}
      trigger={({ toggle }) => <button onClick={toggle} className="btn-icon h-8 w-8"><MoreHorizontal size={16} /></button>}
    >
      {(close) => (
        <>
          <MenuItem icon={<Info size={15} />} onClick={() => { onDetail(a); close() }}>Детали</MenuItem>
          {tab === 'accounts' ? (
            <>
              {a.status === 'reauth' ? (
                <MenuItem icon={<KeyRound size={15} />} onClick={() => { onReauth(a); close() }}>Войти снова</MenuItem>
              ) : (
                <MenuItem icon={<KeyRound size={15} />} onClick={() => { onMarkReauth(a); close() }}>Отправить на реавторизацию</MenuItem>
              )}
              <MenuItem icon={<Rocket size={15} />} onClick={() => { onAssign(a); close() }}>Кампания аккаунта</MenuItem>
              <MenuItem icon={<Server size={15} />} onClick={() => { onProxy(a); close() }}>{hasProxy(a) ? 'Сменить прокси' : 'Добавить прокси'}</MenuItem>
              <MenuItem icon={<Trash2 size={15} />} tone="danger" onClick={() => { onTrash(a); close() }}>В корзину</MenuItem>
            </>
          ) : (
            <MenuItem icon={<Undo2 size={15} />} onClick={() => { onRestore(a); close() }}>Восстановить</MenuItem>
          )}
        </>
      )}
    </Dropdown>
  )
}

/** §1: назначить аккаунт кампании — с локом («присвоить») или без («использовать»). */
function AssignCampaignModal({ acc, campaigns, current, onClose, onApply }: {
  acc: TgAccount | null
  campaigns: Campaign[]
  current: { name: string; locked: boolean } | null
  onClose: () => void
  onApply: (campaignId: string, lock: boolean) => void
}) {
  const [cid, setCid] = useState('')
  const [lock, setLock] = useState(true)
  useEffect(() => {
    if (!acc) return
    const own = campaigns.find((c) => (c.accountIds || []).includes(acc.id))
    setCid(own?.id ?? '')
    setLock(current?.locked ?? true)
  }, [acc, campaigns, current])
  if (!acc) return null
  return (
    <Modal
      open
      onClose={onClose}
      title="Кампания аккаунта"
      subtitle={`${acc.name} — под какой кампанией работает`}
      icon={<Rocket size={22} />}
      size="sm"
      footer={<>
        <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
        <button onClick={() => onApply(cid, lock)} className="btn-primary h-10">Применить</button>
      </>}
    >
      <label className="label">Кампания</label>
      <Select
        value={cid}
        onChange={setCid}
        placeholder="Без кампании (общий пул)"
        options={[{ value: '', label: 'Без кампании (вернуть в общий пул)' }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]}
      />
      {/* Закрепление — политика ВСЕЙ кампании, а не свойство одного аккаунта. Пока в
          кампании никого нет, её можно задать здесь; если аккаунты уже есть, менять её
          отсюда нельзя — иначе назначение одного профиля переписало бы режим у всех
          остальных (прогон 21–22.07, тест 3.5). */}
      {cid && (() => {
        const target = campaigns.find((c) => c.id === cid)
        const already = (target?.accountIds || []).length > 0
        return already ? (
          <p className="mt-3 rounded-lg border border-line bg-elevated/40 px-3 py-2 text-[11px] text-muted">
            Режим кампании «{target?.name}» — <b className="text-fg">{target?.pinned ? 'с закреплением' : 'без лока'}</b>.
            Он общий для всех её аккаунтов и меняется на странице кампании, а не здесь.
          </p>
        ) : (
          <>
            <label className="mt-3 flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
              Присвоить с закреплением (замок) — аккаунты выйдут из общего пула
            </label>
            <p className="mt-2 text-[11px] text-muted">
              Кампания пока пустая — задаёте режим для неё целиком. Без галочки — «использовать
              без лока»: аккаунты остаются доступны другим кампаниям.
            </p>
          </>
        )
      })()}
    </Modal>
  )
}

/**
 * Готовые распорядки (§4.2). Проценты, а не доли: оператор мыслит «80% в обед»,
 * а не «0.8». Ночь у всех почти нулевая — активность в 3:00 палит бота вернее всего.
 */
const hours = (list: number[]): SchedulePercent =>
  Object.fromEntries(list.map((v, h) => [h, v])) as SchedulePercent

const DAY_PRESETS: Record<string, { label: string; hint: string; hours: SchedulePercent }> = {
  day: {
    label: 'Обычный день',
    hint: 'активен с утра до ночи, спит 2–5',
    hours: hours([10, 5, 0, 0, 0, 2, 15, 45, 65, 80, 85, 85, 75, 90, 85, 85, 80, 75, 70, 75, 80, 75, 55, 30]),
  },
  evening: {
    label: 'Вечерний',
    hint: 'днём занят, оживает после 18:00',
    hours: hours([20, 10, 0, 0, 0, 0, 5, 15, 20, 25, 25, 25, 35, 25, 25, 30, 40, 60, 85, 90, 90, 85, 70, 45]),
  },
  work: {
    label: 'Рабочие часы',
    hint: 'только 9–18, как из офиса',
    hours: hours([0, 0, 0, 0, 0, 0, 5, 20, 55, 85, 90, 90, 70, 85, 90, 90, 85, 70, 30, 15, 10, 5, 0, 0]),
  },
  always: {
    label: 'Без ограничений',
    hint: '100% круглосуточно — быстро, но заметно',
    hours: hours(Array.from({ length: 24 }, () => 100)),
  },
}

/**
 * Массовое снятие спамблока через @SpamBot с РАНДОМНЫМИ задержками (анти-кластер §4.4).
 *
 * Апелляция ≠ гарантия: это жалоба модераторам Telegram. Временные ограничения часто
 * снимаются, жёсткий спамблок может остаться. Показываем честный итог по каждому аккаунту.
 * Операция фоновая — прогресс опрашиваем; успешно снятые сразу возвращаются в «active».
 */
function UnblockModal({ open, ids, onClose, onFinished, pushToast }: {
  open: boolean
  ids: string[]
  names: Record<string, string>
  onClose: () => void
  onFinished: () => void
  pushToast: (t: { type: 'success' | 'error' | 'info'; title: string; desc?: string }) => void
}) {
  const navigate = useNavigate()
  const [delayMin, setDelayMin] = useState(30)
  const [delayMax, setDelayMax] = useState(120)
  const [starting, setStarting] = useState(false)

  const run = async () => {
    if (!ids.length) return
    setStarting(true)
    try {
      await startUnblock(ids, delayMin, delayMax)
      pushToast({ type: 'success', title: `Задача снятия спамблока запущена: ${ids.length} акк.`, desc: 'Идёт в фоне — прогресс в «Дашборде задач»' })
      onClose()
      onFinished()
      navigate('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не запустилось', desc: e instanceof Error ? e.message : '' })
    } finally { setStarting(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Снять спамблок через @SpamBot">
      <div className="space-y-4">
        <p className="text-sm text-white/60">
          Запустит <b className="text-white">фоновую задачу</b>: апелляция в @SpamBot по{' '}
          <b className="text-white">{ids.length}</b> аккаунт(ам) со спамблоком, по одному, с рандомными
          паузами. Прогресс и «Стоп» — в «Дашборде задач».
        </p>
        <p className="text-xs text-amber-300/80">
          Это жалоба модераторам Telegram — временные ограничения часто снимаются, жёсткий спамблок может остаться.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="label">Пауза от, сек
            <NumberField value={delayMin} onChange={(v) => setDelayMin(Math.max(5, v))} min={5} max={600} />
          </label>
          <label className="label">Пауза до, сек
            <NumberField value={delayMax} onChange={(v) => setDelayMax(Math.max(delayMin, v))} min={5} max={600} />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
          <button onClick={() => void run()} disabled={starting || !ids.length} className="btn-primary h-10 disabled:opacity-40">
            {starting ? <><Loader2 size={15} className="animate-spin" /> Запуск…</> : <><ShieldCheck size={15} /> Запустить для {ids.length}</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * §4.5 (D2), прямой запрос владельца: «чтобы можно было МАССОВО всем задавать усталость
 * и отдых от модулей, как живой человек, чтобы выглядели».
 *
 * Три операции намеренно разделены: задать профиль — это надолго, отправить отдыхать —
 * разово «сейчас», сбросить усталость — вернуть в строй раньше срока. Смешивать их
 * в одной кнопке значило бы, что оператор не понимает, что именно применил.
 */
function FatigueModal({ open, ids, activity, onClose, onDone, onError }: {
  open: boolean
  ids: string[]
  /** Текущие профили аккаунтов — форма обязана показывать сохранённое, а не умолчания. */
  activity: ActivityMap
  onClose: () => void
  onDone: (map: ActivityMap, message: string) => void
  onError: (e: string) => void
}) {
  const [threshold, setThreshold] = useState(15)
  const [restMinutes, setRestMinutes] = useState(45)
  const [recoveryPerHour, setRecoveryPerHour] = useState(5)
  /** Значения выбранных аккаунтов различаются — предупреждаем, что «Применить» их сравняет. */
  const [mixed, setMixed] = useState(false)

  // Подставляем сохранённые значения при КАЖДОМ открытии (правка 18.08). Раньше поля
  // всегда стартовали с 15/45/5, и это читалось как «настройки слетели после деплоя»;
  // хуже того — повторное «Применить» записывало умолчания поверх заданного.
  useEffect(() => {
    if (!open) return
    const rows = ids.map((id) => activity[id]).filter(Boolean)
    if (!rows.length) { setMixed(false); return }
    const pick = (get: (a: typeof rows[number]) => number | undefined, fallback: number) => {
      const vals = rows.map(get).filter((v): v is number => typeof v === 'number')
      if (!vals.length) return { value: fallback, same: true }
      return { value: vals[0], same: vals.every((v) => v === vals[0]) }
    }
    const th = pick((a) => a.threshold, 15)
    const rest = pick((a) => a.restMinutes, 45)
    const rec = pick((a) => a.recoveryPerHour, 5)
    setThreshold(th.value); setRestMinutes(rest.value); setRecoveryPerHour(rec.value)
    setMixed(!(th.same && rest.same && rec.same))
  }, [open, ids, activity])
  const [restNow, setRestNow] = useState(60)
  const [busy, setBusy] = useState(false)
  const [schedule, setSchedule] = useState<SchedulePercent>(() => ({ ...DAY_PRESETS.day.hours }))
  const [spread, setSpread] = useState(true)

  const run = async (patch: Parameters<typeof setActivity>[0], message: string) => {
    setBusy(true)
    try {
      const r = await setActivity(patch)
      onDone(r.activity, `${message}: ${r.applied} акк.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Усталость и отдых"
      subtitle={`Выбрано аккаунтов: ${ids.length}`}
      icon={<Pause size={22} />}
      size="md"
      footer={<button onClick={onClose} className="btn-ghost h-10">Закрыть</button>}
    >
      <p className="mb-3 text-xs text-white/45">
        Усталость общая для ВСЕХ модулей: аккаунт, отработавший смену в комментинге,
        не уйдёт тут же лить реакции — он отдыхает, как живой человек.
        {ids.length === 1 ? ' Показаны настройки этого аккаунта.' : ' Значения можно задать каждому аккаунту свои — выберите один и откройте это окно из его меню.'}
      </p>
      {mixed && (
        <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          У выбранных аккаунтов значения различаются — показано значение первого.
          «Применить» задаст одинаковые всем выбранным.
        </p>
      )}

      {/* Три поля описывают один цикл. Раньше «отдых» и «восстановление» читались как
          одно и то же — подписи объясняют, чем они отличаются, на числах из формы. */}
      <label className="label">1. Порог усталости <span className="text-white/30">— сколько действий подряд</span></label>
      <NumberField value={threshold} onChange={setThreshold} min={1} max={500} className="input h-10 w-full" />
      <p className="mt-1 text-[11px] text-white/40">
        Каждое действие в любом модуле — плюс единица. Набрал {threshold} — уходит на перерыв.
      </p>

      <label className="label mt-3">2. Перерыв после порога, минут <span className="text-white/30">— пауза целиком</span></label>
      <NumberField value={restMinutes} onChange={setRestMinutes} min={1} max={1440} className="input h-10 w-full" />
      <p className="mt-1 text-[11px] text-white/40">
        {restMinutes} мин аккаунт не берут НИ В ОДИН модуль. После перерыва счётчик обнуляется и он снова в строю.
      </p>

      <label className="label mt-3">3. Восстановление <span className="text-white/30">— за час простоя</span></label>
      <NumberField value={recoveryPerHour} onChange={setRecoveryPerHour} min={1} max={100} className="input h-10 w-full" />
      <p className="mt-1 text-[11px] text-white/40">
        Работает, пока до порога НЕ дошли: за час без действий счётчик падает на {recoveryPerHour}.
        Это «отдышался между делом», а не перерыв из пункта 2.
      </p>

      <button
        disabled={busy || !ids.length}
        onClick={() => void run({ accountIds: ids, profile: { threshold, restMinutes, recoveryPerHour } }, 'Профиль задан')}
        className="btn-primary mt-3 h-10 w-full disabled:opacity-40"
      >
        Применить профиль ко всем выбранным
      </button>

      {/* §4.2: распорядок дня. Правится массово и в процентах — на живом прогоне 23.07
          старая шкала (3% днём) заставляла модуль завершаться с нулём действий. */}
      <div className="mt-4 border-t border-line pt-3">
        <label className="label">Распорядок дня <span className="text-white/30">— шанс привлечения по часам, %</span></label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {Object.entries(DAY_PRESETS).map(([key, p]) => (
            <button
              key={key}
              onClick={() => setSchedule({ ...p.hours })}
              title={p.hint}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-white/70 hover:bg-elevated"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-6 gap-1">
          {Array.from({ length: 24 }, (_, h) => {
            const v = Number(schedule[h] ?? 0)
            return (
              <label key={h} className="flex flex-col gap-0.5" title={`${h}:00 — ${v}%`}>
                <span className="text-center text-[10px] tabular-nums text-white/35">
                  {String(h).padStart(2, '0')}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={v}
                  onChange={(e) => {
                    const n = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)))
                    setSchedule((s) => ({ ...s, [h]: n }))
                  }}
                  className={cn(
                    'input h-8 w-full px-1 text-center text-[11px] tabular-nums',
                    v === 0 && 'text-white/25',
                  )}
                />
              </label>
            )
          })}
        </div>

        <label className="mt-2.5 flex items-start gap-2 text-xs text-white/60">
          <input type="checkbox" checked={spread} onChange={(e) => setSpread(e.target.checked)} className="mt-0.5" />
          <span>
            Сдвинуть у каждого аккаунта по-своему
            <span className="block text-[11px] text-white/35">
              ±2 часа и разная амплитуда. Один распорядок на всю пачку — сам по себе
              признак фермы: профили оживают и замолкают в одну минуту.
            </span>
          </span>
        </label>

        <button
          disabled={busy || !ids.length}
          onClick={() => void run({ accountIds: ids, schedule, spread }, 'Распорядок задан')}
          className="btn-primary mt-2 h-10 w-full disabled:opacity-40"
        >
          Применить распорядок ко всем выбранным
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <label className="label">Отправить отдыхать прямо сейчас, минут</label>
        <div className="flex gap-2">
          <NumberField value={restNow} onChange={setRestNow} min={1} max={1440} className="input h-10 flex-1" />
          <button
            disabled={busy || !ids.length}
            onClick={() => void run({ accountIds: ids, restMinutes: restNow }, 'Отправлены на отдых')}
            className="btn-ghost h-10 shrink-0 px-4 disabled:opacity-40"
          >
            Отдых
          </button>
        </div>
        <button
          disabled={busy || !ids.length}
          onClick={() => void run({ accountIds: ids, reset: true }, 'Усталость сброшена')}
          className="btn-ghost mt-2 h-10 w-full disabled:opacity-40"
        >
          Сбросить усталость и вернуть в строй
        </button>
      </div>
    </Modal>
  )
}
