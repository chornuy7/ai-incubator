import { useMemo, useState, useEffect } from 'react'
import {
  Plus, UploadCloud, Server, RefreshCw, Columns3, ListChecks, Search, Filter,
  MoreHorizontal, Trash2, KeyRound, Info, Users, Check, X, Undo2, Loader2,
} from 'lucide-react'
import { useApp, activeAccounts, trashedAccounts, STATUS_META } from '@/mocks/store'
import { useUi } from '@/shared/lib/uiStore'
import {
  PageHeader, Avatar, StatusBadge, EmptyState, Dropdown, MenuItem, Select, Skeleton, Modal,
} from '@/shared/ui'
import { AddAccountWizard } from '@/features/add-tg-account/AddAccountWizard'
import { ImportModal } from '@/features/import-sessions/ImportModal'
import { ProxyPoolModal } from '@/features/proxy/ProxyPoolModal'
import { AccountManagementModal } from '@/features/account-manager/AccountManagementModal'
import { AiSafetyModal } from '@/features/modules/shared'
import { PaywallLock } from '@/features/paywall/Paywall'
import { cn } from '@/shared/lib/utils'
import { ROLES, COUNTRIES_FILTER } from '@/shared/config/modules'
import type { AccountStatus, TgAccount } from '@/shared/types'
import { patchAccount, releaseAccountLock } from '@/api/accountsApi'

const STATUS_ORDER: AccountStatus[] = ['active', 'working', 'quarantine', 'spamblock', 'invalid', 'frozen', 'reauth']
const COLS = [
  { key: 'avatar', label: 'Аватар' },
  { key: 'name', label: 'Имя' },
  { key: 'role', label: 'Роль' },
  { key: 'project', label: 'Проект' },
  { key: 'status', label: 'Статус' },
  { key: 'lastSeen', label: 'Отлёжка' },
  { key: 'proxy', label: 'Прокси' },
]
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
  const setTasksOpen = useUi((s) => s.setTasksOpen)

  const [tab, setTab] = useState<'accounts' | 'trash'>('accounts')
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'all'>('all')
  const [roleFilter, setRoleFilter] = useState('Все роли')
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

  const active = activeAccounts(data)
  const trashed = trashedAccounts(data)

  const statusCounts = useMemo(() => {
    const c: Record<AccountStatus, number> = { active: 0, working: 0, quarantine: 0, spamblock: 0, invalid: 0, frozen: 0, reauth: 0 }
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
      if (roleFilter !== 'Все роли' && a.role !== roleFilter) return false
      if (countryFilter !== 'all' && a.country !== countryFilter) return false
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
  }, [source, tab, statusFilter, roleFilter, countryFilter, moduleFilter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageItems = filtered.slice(page * pageSize, page * pageSize + pageSize)

  const allOnPageSelected = pageItems.length > 0 && pageItems.every((a) => selected.has(a.id))
  const toggleAll = () => {
    const next = new Set(selected)
    if (allOnPageSelected) pageItems.forEach((a) => next.delete(a.id))
    else pageItems.forEach((a) => next.add(a.id))
    setSelected(next)
  }
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  const bulkTrash = () => {
    void (async () => {
      for (const id of selected) await trashAccount(id)
      pushToast({ type: 'success', title: `В корзину: ${selected.size}`, desc: 'Аккаунты перемещены в корзину.' })
      setSelected(new Set())
    })()
  }

  // (8) Массовые действия
  const bulkSetStatus = (status: AccountStatus, title: string) => {
    void (async () => {
      const ids = [...selected]
      for (const id of ids) { try { await patchAccount(id, { status }) } catch { /* skip */ } }
      await loadAccounts()
      pushToast({ type: 'success', title, desc: `Аккаунтов: ${ids.length}` })
      setSelected(new Set())
    })()
  }

  const bulkRelease = () => {
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

  const bulkMove = (patch: { role?: string; project?: string }) => {
    void (async () => {
      const ids = [...selected]
      for (const id of ids) { try { await patchAccount(id, patch) } catch { /* skip */ } }
      await loadAccounts()
      pushToast({ type: 'success', title: 'Перемещено', desc: `Аккаунтов: ${ids.length}` })
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
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Роль</div>
              <Select className="mb-3" value={roleFilter} onChange={setRoleFilter} options={ROLES.map((r) => ({ value: r, label: r }))} />
              <div className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">Страна</div>
              <Select className="mb-3" value={countryFilter} onChange={setCountryFilter} options={COUNTRIES_FILTER.map((c) => ({ value: c.code, label: `${c.flag} ${c.label}`.trim() }))} />
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

      {/* Bulk bar */}
      {selected.size > 0 && tab === 'accounts' && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-spark-500/40 bg-spark-500/8 px-4 py-2.5 animate-fade-in">
          <span className="text-sm font-bold text-spark-300">Выбрано: {selected.size}</span>
          <button onClick={() => bulkSetStatus('active', 'Включено (active)')} className="btn-ghost h-8 text-xs"><Check size={14} /> Включить</button>
          <button onClick={() => bulkSetStatus('frozen', 'Отключено (frozen)')} className="btn-ghost h-8 text-xs"><X size={14} /> Отключить</button>
          <button onClick={bulkRelease} className="btn-ghost h-8 text-xs"><RefreshCw size={14} /> Стоп / освободить</button>
          <button onClick={() => setMoveOpen(true)} className="btn-ghost h-8 text-xs"><Users size={14} /> Переместить</button>
          <button onClick={bulkTrash} className="btn-ghost h-8 text-xs"><Trash2 size={14} /> В корзину</button>
          <button onClick={() => { void (async () => { for (const id of selected) await setAccountStatus(id, 'reauth'); pushToast({ type: 'info', title: 'Отправлено на реавторизацию' }); setSelected(new Set()) })() }} className="btn-ghost h-8 text-xs"><KeyRound size={14} /> Реавторизация</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost h-8 text-xs">Снять</button>
        </div>
      )}

      {/* Table / content */}
      {isNoSub ? (
        <PaywallLock>
          <AccountsTable pageItems={active.slice(0, 3)} visibleCols={visibleCols} showCol={showCol} selected={selected} toggleOne={() => {}} allOnPageSelected={false} toggleAll={() => {}} tab="accounts" onDetail={() => {}} onProxy={() => {}} onTrash={() => {}} onRestore={() => {}} onReauth={() => {}} onMarkReauth={() => {}} loading={false} />
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
            pageItems={pageItems}
            visibleCols={visibleCols}
            showCol={showCol}
            selected={selected}
            toggleOne={toggleOne}
            allOnPageSelected={allOnPageSelected}
            toggleAll={toggleAll}
            tab={tab}
            onDetail={setDetailAcc}
            onProxy={setProxyAcc}
            onTrash={(a) => { void trashAccount(a.id).then(() => pushToast({ type: 'success', title: 'В корзину', desc: a.name })) }}
            onRestore={(a) => { void restoreAccount(a.id).then(() => pushToast({ type: 'success', title: 'Восстановлено', desc: a.name })) }}
            onReauth={openReauth}
            onMarkReauth={(a) => { void setAccountStatus(a.id, 'reauth').then(() => pushToast({ type: 'info', title: 'Требуется реавторизация', desc: a.name })) }}
            loading={false}
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
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <ProxyPoolModal open={proxyPoolOpen} onClose={() => setProxyPoolOpen(false)} />

      {/* Account Management (реальная статистика) */}
      <AccountManagementModal account={detailAcc} onClose={() => setDetailAcc(null)} />

      {/* Change proxy */}
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
  toggleAll: () => void
  tab: 'accounts' | 'trash'
  onDetail: (a: TgAccount) => void
  onProxy: (a: TgAccount) => void
  onTrash: (a: TgAccount) => void
  onRestore: (a: TgAccount) => void
  onReauth: (a: TgAccount) => void
  onMarkReauth: (a: TgAccount) => void
  loading: boolean
}) {
  const { pageItems, showCol, selected, toggleOne, allOnPageSelected, toggleAll } = props
  const showAccountCol = showCol('name') || showCol('avatar')
  return (
    <div className="card overflow-hidden p-0">
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-elevated/60 text-left text-[11px] font-bold uppercase tracking-wide text-muted">
              <th className="w-10 px-4 py-3"><input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} className="h-4 w-4 rounded border-line accent-spark-500" /></th>
              {showAccountCol && <th className="px-4 py-3">Аккаунт</th>}
              {showCol('role') && <th className="px-4 py-3">Роль</th>}
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
                  <div className="flex items-center gap-3">
                    {showCol('avatar') && <Avatar name={a.name} color={a.avatarColor} />}
                    <div className="min-w-0">
                      {showCol('name') && <div className="truncate font-semibold text-fg">{a.name}</div>}
                      <div className="truncate text-xs text-muted">@{a.username} · {a.phone}</div>
                    </div>
                  </div>
                </td>
                )}
                {showCol('role') && <td className="px-4 py-3 text-muted">{a.role}</td>}
                {showCol('project') && <td className="px-4 py-3"><span className="rounded-md bg-elevated px-2 py-0.5 text-xs font-medium text-fg">{a.project}</span></td>}
                {showCol('status') && (
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <StatusBadge status={a.status} />
                      {a.busyIn && (
                        <div className="flex items-center gap-1 text-[11px] font-semibold text-rose-300">
                          <Loader2 size={11} className="animate-spin" /> В работе: {a.busyIn.moduleLabel}
                        </div>
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
            <Avatar name={a.name} color={a.avatarColor} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-fg">{a.name}</div>
              <div className="truncate text-xs text-muted">@{a.username} · {a.phone}</div>
              <div className="mt-1.5">
                <StatusBadge status={a.status} />
                {a.busyIn && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-rose-300">
                    <Loader2 size={11} className="animate-spin" /> В работе: {a.busyIn.moduleLabel}
                  </div>
                )}
              </div>
            </div>
            <RowMenu a={a} {...props} />
          </div>
        ))}
      </div>
    </div>
  )
}

function RowMenu({ a, tab, onDetail, onProxy, onTrash, onRestore, onReauth, onMarkReauth }: {
  a: TgAccount; tab: 'accounts' | 'trash'
  onDetail: (a: TgAccount) => void; onProxy: (a: TgAccount) => void
  onTrash: (a: TgAccount) => void; onRestore: (a: TgAccount) => void
  onReauth: (a: TgAccount) => void; onMarkReauth: (a: TgAccount) => void
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

function ChangeProxyModal({ acc, onClose, onSave }: { acc: TgAccount | null; onClose: () => void; onSave: (id: string, proxy: string) => void }) {
  const [useProxy, setUseProxy] = useState(true)
  const [value, setValue] = useState('')

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
          <label className="label">Новый прокси</label>
          <input value={value} onChange={(e) => setValue(e.target.value)} className="input" placeholder="socks5://host:port" />
          <p className="mt-2 text-xs text-muted">Текущий: <span className="font-mono">{formatProxyLabel(acc?.proxy ?? '')}</span></p>
        </>
      ) : (
        <p className="text-sm text-muted">Аккаунт будет подключаться напрямую, без SOCKS5/HTTP прокси.</p>
      )}
    </Modal>
  )
}
