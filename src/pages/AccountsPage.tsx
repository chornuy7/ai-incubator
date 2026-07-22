import { useMemo, useState, useEffect, useRef } from 'react'
import {
  Plus, UploadCloud, Server, RefreshCw, Columns3, ListChecks, Search, Filter,
  MoreHorizontal, Trash2, KeyRound, Info, Users, Check, X, Undo2, Loader2, Pause,
  Lock, LockOpen, Rocket,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useApp, activeAccounts, trashedAccounts, STATUS_META } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { filterAccountsByAccess } from '@/shared/lib/access'
import { useUi } from '@/shared/lib/uiStore'
import {
  PageHeader, Avatar, StatusBadge, EmptyState, Dropdown, MenuItem, Select, Skeleton, Modal,
} from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { accountLabel, accountSub } from '@/features/conversation/AccountRail'
import { AddAccountWizard } from '@/features/add-tg-account/AddAccountWizard'
import { ImportModal } from '@/features/import-sessions/ImportModal'
import { ProxyPoolModal } from '@/features/proxy/ProxyPoolModal'
import { AccountManagementModal } from '@/features/account-manager/AccountManagementModal'
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

const STATUS_ORDER: AccountStatus[] = ['active', 'working', 'warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'invalid', 'frozen', 'reauth']
const COLS = [
  { key: 'avatar', label: 'Аватар' },
  { key: 'name', label: 'Имя' },
  { key: 'campaign', label: 'Кампания' },
  { key: 'project', label: 'Проект' },
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
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      title={title}
      className="h-4 w-4 rounded border-line accent-spark-500"
    />
  )
}

function formatProxyLabel(proxy: string) {
  if (!proxy || proxy === '—') return 'Прямое подключение'
  return proxy
}

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

  const [tab, setTab] = useState<'accounts' | 'trash'>('accounts')
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'all'>('all')
  const [roleFilter, setRoleFilter] = useState('Все роли')
  // §1: «роль как группа» уходит — аккаунт работает ПОД КАМПАНИЕЙ. Закрепление живёт
  // в самой кампании (см. server/campaigns.js), поэтому accountsMeta.role не трогаем.
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({})
  const [campaignFilter, setCampaignFilter] = useState('all')
  const [trashAlive, setTrashAlive] = useState(false) // §2: показать только «живые» среди удалённых
  // §12: без списка групп доступ роли «на группу» не применялся бы (был баг — фильтр не видел групп).
  const [accGroups, setAccGroups] = useState<AccountGroup[]>([])
  useEffect(() => { void fetchAccountGroups().then(({ groups }) => setAccGroups(groups)).catch(() => {}) }, [])
  const loadCampaigns = () => {
    void fetchCampaigns().then(({ campaigns: cs, pinned }) => { setCampaigns(cs); setPinnedMap(pinned) }).catch(() => {})
  }
  useEffect(() => { loadCampaigns() }, [])
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
          await updateCampaign(campaignId, { accountIds: ids, pinned: lock })
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
  const [visibleCols, setVisibleCols] = useState<string[]>(COLS.map((c) => c.key))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  const [addOpen, setAddOpen] = useState(false)
  const [wizardMode, setWizardMode] = useState<'add' | 'reauth'>('add')
  const [reauthTarget, setReauthTarget] = useState<TgAccount | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [proxyPoolOpen, setProxyPoolOpen] = useState(false)
  const [detailAcc, setDetailAcc] = useState<TgAccount | null>(null)
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
      return true
    })
    // Свободные — сверху, занятые (в работе) — в самый низ. Стабильно сохраняем прочий порядок.
    return list
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (Number(!!x.a.busyIn) - Number(!!y.a.busyIn)) || (x.i - y.i))
      .map((x) => x.a)
  }, [source, tab, statusFilter, campaignFilter, campaigns, pinnedMap, countryFilter, moduleFilter, query, trashAlive])

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
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7">
        {STATUS_ORDER.map((st) => {
          const m = STATUS_META[st]
          const activeCard = statusFilter === st
          return (
            <button
              key={st}
              onClick={() => { setStatusFilter(activeCard ? 'all' : st); setPage(0); setTab('accounts') }}
              className={cn(
                'flex items-center gap-3 rounded-2xl border p-3 text-left transition-all',
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
            </button>
          )
        })}
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

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-line bg-elevated p-1">
          <button onClick={() => { setTab('accounts'); setPage(0); setSelected(new Set()) }} className={cn('rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-all', tab === 'accounts' ? 'bg-spark-gradient text-[#04150c]' : 'text-muted hover:text-fg')}>
            Аккаунты <span className="opacity-70">{active.length}</span>
          </button>
          <button onClick={() => { setTab('trash'); setPage(0); setSelected(new Set()) }} className={cn('rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-all', tab === 'trash' ? 'bg-spark-gradient text-[#04150c]' : 'text-muted hover:text-fg')}>
            Корзина <span className="opacity-70">{trashed.length}</span>
          </button>
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} className="input pl-9" placeholder="Поиск по имени, @username, номеру…" />
        </div>

        {/* Filters dropdown */}
        <Dropdown
          width={260}
          trigger={({ toggle, open }) => (
            <button onClick={toggle} className={cn('btn-ghost h-10', (roleFilter !== 'Все роли' || countryFilter !== 'all' || open) && 'border-spark-500/40 text-spark-300')}>
              <Filter size={16} /> <span className="hidden sm:inline">Фильтры</span>
            </button>
          )}
        >
          {() => (
            <div className="p-1.5">
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Кампания</div>
              <Select
                className="mb-3"
                value={campaignFilter}
                onChange={setCampaignFilter}
                options={[
                  { value: 'all', label: 'Все кампании' },
                  { value: 'pool', label: 'В общем пуле (не закреплены)' },
                  ...campaigns.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
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
              <button onClick={() => { setRoleFilter('Все роли'); setCountryFilter('all'); setModuleFilter('all') }} className="btn-ghost mt-3 h-8 w-full text-xs">Сбросить фильтры</button>
            </div>
          )}
        </Dropdown>

        <button onClick={() => { void loadAccounts(); pushToast({ type: 'info', title: 'Обновлено', desc: 'Список загружен с сервера.' }) }} className="btn-ghost h-10">
          <RefreshCw size={16} /> <span className="hidden sm:inline">Обновить</span>
        </button>

        {/* Columns */}
        <Dropdown
          width={200}
          trigger={({ toggle }) => <button onClick={toggle} className="btn-ghost h-10"><Columns3 size={16} /> <span className="hidden sm:inline">Колонки</span></button>}
        >
          {() => (
            <div className="p-1">
              {COLS.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setVisibleCols((v) => (v.includes(c.key) ? v.filter((x) => x !== c.key) : [...v, c.key]))}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-elevated"
                >
                  {c.label}
                  {showCol(c.key) && <Check size={15} className="text-spark-400" />}
                </button>
              ))}
            </div>
          )}
        </Dropdown>

        <button onClick={() => setTasksOpen(true)} className="btn-ghost h-10"><ListChecks size={16} /> <span className="hidden sm:inline">Задачи</span></button>

        {tab === 'trash' && trashed.length > 0 && (
          <button onClick={() => { void emptyTrash().then(() => pushToast({ type: 'success', title: 'Корзина очищена' })) }} className="btn-danger h-10"><Trash2 size={16} /> Очистить корзину</button>
        )}
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
        const btn = (tone: string) => `flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${has ? tone : 'border-line text-white/25'}`
        return (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 px-4 py-2.5">
          <span className={`text-sm font-bold ${has ? 'text-spark-300' : 'text-white/40'}`}>{has ? `Выбрано: ${selected.size}` : 'Выберите аккаунты для управления'}</span>
          <button disabled={!has} onClick={() => bulkStatusManual('active', 'Включено')} className={btn('border-spark-500/50 bg-spark-500/12 text-spark-300 hover:bg-spark-500/20')}><Check size={14} /> Запустить</button>
          <button disabled={!has} onClick={() => bulkStatusManual('pause', 'На паузе')} className={btn('border-amber-500/50 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20')}><Pause size={14} /> Пауза</button>
          <button disabled={!has} onClick={bulkRelease} className={btn('border-rose-500/50 bg-rose-500/12 text-rose-300 hover:bg-rose-500/20')}><RefreshCw size={14} /> Стоп / освободить</button>
          <button disabled={!has} onClick={() => bulkSetStatus('frozen', 'Отключено (frozen)')} className={btn('border-rose-500/40 bg-rose-500/8 text-rose-300 hover:bg-rose-500/15')}><X size={14} /> Отключить</button>
          <span className="mx-1 h-5 w-px bg-line" />
          <button disabled={!has} onClick={() => setMoveOpen(true)} className={btn('border-line text-fg hover:bg-elevated')}><Users size={14} /> Переместить</button>
          <button disabled={!has} onClick={() => { void (async () => { for (const id of selected) await setAccountStatus(id, 'reauth'); pushToast({ type: 'info', title: 'Отправлено на реавторизацию' }); setSelected(new Set()) })() }} className={btn('border-line text-fg hover:bg-elevated')}><KeyRound size={14} /> Реавторизация</button>
          {/* §2: «Управление» — мульти-просмотр ВЫБРАННЫХ аккаунтов: открываем обзор на первом
              и передаём весь выбор в `?sel=`, чтобы слева был список только выбранных, а не всех. */}
          <button
            disabled={!has}
            onClick={() => {
              const chosen = active.filter((a) => selected.has(a.id))
              if (!chosen.length) return
              navigate(`/panel/accounts/${chosen[0].id}?sel=${chosen.map((a) => a.id).join(',')}`)
            }}
            title="Открыть обзор выбранных аккаунтов: слева — только они, справа — табы"
            className={btn('border-iris-500/50 bg-iris-500/12 text-iris-200 hover:bg-iris-500/20')}
          ><Users size={14} /> Управление</button>
          {/* §2: «В корзину» — самая редкая деструктивная функция, поэтому крайняя справа. */}
          <button
            disabled={!has}
            onClick={bulkTrash}
            title={busySelected.length ? 'Среди выбранных есть аккаунты в работе — сначала остановите' : 'Переместить выбранные в корзину'}
            className={cn(btn('border-line text-fg hover:bg-elevated'), 'ml-auto', busySelected.length && 'opacity-60')}
          >
            <Trash2 size={14} /> В корзину{busySelected.length ? ` (${busySelected.length} в работе)` : ''}
          </button>
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
    </div>
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
  /** §1: под какой кампанией аккаунт и закреплён ли (замочек). */
  campaignOf: (accountId: string) => { name: string; locked: boolean } | null
  onAssign: (a: TgAccount) => void
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
              {showCol('project') && <th className="px-4 py-3">Проект</th>}
              {showCol('status') && <th className="px-4 py-3">Статус</th>}
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
                  <button type="button" onClick={() => props.onDetail(a)} className="group flex items-center gap-3 text-left" title="Открыть статистику аккаунта">
                    {showCol('avatar') && <Avatar name={accountLabel(a)} color={a.avatarColor} />}
                    <div className="min-w-0">
                      {showCol('name') && <div className="truncate font-semibold text-fg transition-colors group-hover:text-spark-300">{accountLabel(a)}</div>}
                      <div className="truncate text-xs text-muted">{accountSub(a)}</div>
                    </div>
                  </button>
                </td>
                )}
                {showCol('campaign') && (
                  <td className="px-4 py-3">
                    {(() => {
                      const c = campaignOf(a.id)
                      if (!c) return <span className="text-xs text-faint">в общем пуле</span>
                      return (
                        <span className="inline-flex items-center gap-1 text-xs text-fg" title={c.locked ? `Закреплён за кампанией «${c.name}» — вышел из общего пула` : `Используется кампанией «${c.name}» без закрепления`}>
                          {c.locked ? <Lock size={11} className="shrink-0 text-amber-300" /> : <LockOpen size={11} className="shrink-0 text-faint" />}
                          <span className="truncate">{c.name}</span>
                        </span>
                      )
                    })()}
                  </td>
                )}
                {showCol('project') && <td className="px-4 py-3"><span className="rounded-md bg-elevated px-2 py-0.5 text-xs font-medium text-fg">{a.project}</span></td>}
                {showCol('status') && (
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <StatusBadge status={a.status} until={a.statusUntil} reason={a.statusReason} />
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
                        <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-300/70" title="Аккаунт поставлен на паузу оператором, а не задачей модуля">
                          <Pause size={11} /> Пауза вручную · не в модуле
                        </div>
                      ) : null}
                      {/* §2: score виден ВСЕГДА (не только у проблемных) + подсказка, где можно/нельзя. */}
                      {typeof a.trustScore === 'number' && (
                        <span
                          className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                            a.trustBand === 'low' ? 'bg-rose-500/15 text-rose-300'
                              : a.trustBand === 'high' ? 'bg-spark-500/15 text-spark-300'
                                : 'bg-amber-500/15 text-amber-300')}
                          title={a.trustBand === 'low'
                            ? `Trust ${a.trustScore} (<40): в боевые модули не берётся — нужен прогрев. Мейлинг недоступен (нужен trust>70).`
                            : a.trustBand === 'high'
                              ? `Trust ${a.trustScore} (>70): доступны все модули, включая мейлинг.`
                              : `Trust ${a.trustScore} (40–70): боевые модули только на «Консервативном» уровне; мейлинг недоступен (нужен trust>70).`}
                        >
                          trust {a.trustScore}
                          {a.trustBand === 'low' ? ' · прогрев' : a.trustBand !== 'high' ? ' · без мейлинга' : ''}
                        </span>
                      )}
                      {(() => {
                        const d = props.dailyAll?.[a.id]
                        if (!d) return null
                        if (d.anyReached) {
                          const hit = d.items.filter((x) => x.reached).map((x) => DAILY_CAP_LABELS[x.action] ?? x.action).join(', ')
                          return (
                            <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-300" title={`Суточный лимит §6 достигнут: ${hit}. Модули пропускают аккаунт до сброса в полночь.`}>
                              §6 лимит: {hit}
                            </span>
                          )
                        }
                        // Раннее предупреждение: ≥75% любого потолка, но ещё не заблокирован.
                        const near = d.items.filter((x) => x.cap > 0 && !x.reached && x.used / x.cap >= 0.75)
                        if (near.length) {
                          const lbl = near.map((x) => `${DAILY_CAP_LABELS[x.action] ?? x.action} ${x.used}/${x.cap}`).join(', ')
                          return (
                            <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300" title={`Близко к суточному лимиту §6: ${lbl}. Скоро модули начнут пропускать аккаунт.`}>
                              §6 близко: {near.map((x) => DAILY_CAP_LABELS[x.action] ?? x.action).join(', ')}
                            </span>
                          )
                        }
                        return null
                      })()}
                      {a.status === 'reauth' && props.tab === 'accounts' && (
                        <button type="button" onClick={() => props.onReauth(a)} className="text-xs font-semibold text-violet-300 hover:text-violet-200">
                          Войти снова →
                        </button>
                      )}
                    </div>
                  </td>
                )}
                {showCol('lastSeen') && <td className="px-4 py-3 text-muted">{a.lastSeen}</td>}
                {showCol('proxy') && <td className="px-4 py-3 font-mono text-xs text-muted">{formatProxyLabel(a.proxy)}</td>}
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
            <button type="button" onClick={() => props.onDetail(a)} className="flex min-w-0 flex-1 items-center gap-3 text-left" title="Открыть статистику аккаунта">
              <Avatar name={accountLabel(a)} color={a.avatarColor} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-fg">{accountLabel(a)}</div>
                <div className="truncate text-xs text-muted">{accountSub(a)}</div>
                <div className="mt-1.5">
                  <StatusBadge status={a.status} until={a.statusUntil} reason={a.statusReason} />
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
                  <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-300/70" title="Аккаунт поставлен на паузу оператором, а не задачей модуля">
                    <Pause size={11} /> Пауза вручную · не в модуле
                  </div>
                ) : null}
                </div>
              </div>
            </button>
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
              <MenuItem icon={<Server size={15} />} onClick={() => { onProxy(a); close() }}>Сменить прокси</MenuItem>
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
      {cid && (
        <label className="mt-3 flex items-center gap-2 text-xs text-white/70">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
          Присвоить с закреплением (замок) — аккаунт выйдет из общего пула
        </label>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Без галочки — «использовать без лока»: аккаунт остаётся доступен другим кампаниям.
      </p>
    </Modal>
  )
}

function ChangeProxyModal({ acc, onClose, onSave }: { acc: TgAccount | null; onClose: () => void; onSave: (id: string, proxy: string) => void }) {
  const [useProxy, setUseProxy] = useState(true)
  const [value, setValue] = useState('')
  // §10: чаще всего прокси уже есть в базе — предлагаем выбрать, а не вбивать заново.
  const pool = useApp((s) => s.data.proxies)
  const [fromPool, setFromPool] = useState(true)

  useEffect(() => {
    if (!acc) return
    const has = acc.proxy && acc.proxy !== '—'
    setUseProxy(!!has)
    setValue(has ? acc.proxy : '')
  }, [acc?.id])

  return (
    <Modal
      open={!!acc}
      onClose={onClose}
      title="Сменить прокси"
      subtitle={acc?.name}
      icon={<Server size={22} />}
      size="sm"
      footer={<>
        <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
        <button
          onClick={() => acc && onSave(acc.id, useProxy ? (value.trim() || acc.proxy) : '—')}
          className="btn-primary h-10"
        >
          Сохранить
        </button>
      </>}
    >
      <div className="mb-3 inline-flex rounded-lg border border-line bg-elevated p-0.5">
        <button
          type="button"
          onClick={() => setUseProxy(false)}
          className={cn('rounded-md px-3 py-1 text-xs font-semibold', !useProxy ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}
        >
          Без прокси
        </button>
        <button
          type="button"
          onClick={() => setUseProxy(true)}
          className={cn('rounded-md px-3 py-1 text-xs font-semibold', useProxy ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}
        >
          Через прокси
        </button>
      </div>
      {useProxy ? (
        <>
          {/* §10: выбор из уже существующих прокси (мобильные и новые) либо ввод вручную. */}
          <div className="mb-2 inline-flex rounded-lg border border-line bg-elevated p-0.5 text-xs">
            <button type="button" onClick={() => setFromPool(true)}
              className={cn('rounded-md px-2.5 py-1 font-semibold', fromPool ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}>
              Из базы прокси
            </button>
            <button type="button" onClick={() => setFromPool(false)}
              className={cn('rounded-md px-2.5 py-1 font-semibold', !fromPool ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}>
              Ввести новый
            </button>
          </div>
          {fromPool ? (
            pool.length === 0 ? (
              <p className="text-xs text-muted">База прокси пуста — введите новый, он попадёт в базу.</p>
            ) : (
              <>
                <label className="label">Прокси из базы ({pool.length})</label>
                <Select
                  value={value}
                  onChange={setValue}
                  placeholder="Выберите прокси"
                  options={pool.map((p) => {
                    const url = `${p.type}://${p.host}:${p.port}`
                    return { value: url, label: `${url}${p.status === 'dead' ? ' · не отвечает' : ''}${p.usedBy ? ` · занят ${p.usedBy}` : ' · свободен'}` }
                  })}
                />
              </>
            )
          ) : (
            <>
              <label className="label">Новый прокси</label>
              <input value={value} onChange={(e) => setValue(e.target.value)} className="input" placeholder="socks5://host:port" />
            </>
          )}
          <p className="mt-2 text-xs text-muted">Текущий: <span className="font-mono">{formatProxyLabel(acc?.proxy ?? '')}</span></p>
        </>
      ) : (
        <p className="text-sm text-muted">Аккаунт будет подключаться напрямую, без SOCKS5/HTTP прокси.</p>
      )}
    </Modal>
  )
}
