import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { User, Loader2, ArrowLeft, Search } from 'lucide-react'
import { Avatar, StatusBadge, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp, activeAccounts } from '@/mocks/store'
import { fetchAccountStats, releaseAccountLock } from '@/api/accountsApi'
import type { AccountStats } from '@/shared/types'
import {
  TABS, HeroBanner, ProfileTab, ProxyTab, StatusTab, DatesTab, ActionsTab, HealthTab, ChannelsTab, FoldersTab,
  type TabKey,
} from './AccountManagementModal'

/**
 * §3: обзор аккаунта — ВЬЮШКА, а не модалка поверх списка (модалка перегружала экран).
 * Раскладка как почта/WhatsApp: слева колонка аккаунтов с фильтром, справа — те же табы.
 *
 * Выбранный таб СОХРАНЯЕТСЯ при переключении аккаунтов — так удобно сравнивать одно
 * и то же у разных профилей. Чекбокс возвращает прежнее поведение «сбрасывать на профиль».
 */
export function AccountOverviewPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const data = useApp((s) => s.data)
  const pushToast = useApp((s) => s.pushToast)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)

  const accounts = useMemo(() => activeAccounts(data), [data])
  const [params] = useSearchParams()

  /**
   * §2: мульти-просмотр. Кнопка «Управление» в массовых действиях передаёт выбранные
   * id через `?sel=`, и тогда слева показываем ТОЛЬКО их — иначе выбор терялся и
   * список ничем не отличался от обычного обзора одного аккаунта.
   */
  const selectedIds = useMemo(() => {
    const raw = params.get('sel')
    if (!raw) return null
    const ids = new Set(raw.split(',').filter(Boolean))
    return ids.size ? ids : null
  }, [params])
  const [onlySelected, setOnlySelected] = useState(true)

  // Область показа: выбранные или все. Поиск работает уже внутри неё.
  const scope = useMemo(
    () => (selectedIds && onlySelected ? accounts.filter((a) => selectedIds.has(a.id)) : accounts),
    [accounts, selectedIds, onlySelected],
  )

  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scope
    return scope.filter((a) => `${a.name} ${a.username} ${a.phone}`.toLowerCase().includes(q))
  }, [scope, query])

  // Аккаунт из URL ищем среди ВСЕХ: прямая ссылка должна открываться, даже если он вне выбора.
  const account = useMemo(() => accounts.find((a) => a.id === id) ?? scope[0] ?? accounts[0] ?? null, [accounts, scope, id])

  const [tab, setTab] = useState<TabKey>('profile')
  const [resetToProfile, setResetToProfile] = useState(false)
  const [stats, setStats] = useState<AccountStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [spamChecking, setSpamChecking] = useState(false)
  const [releasing, setReleasing] = useState(false)

  const load = useCallback(async (opts?: { spam?: boolean }) => {
    if (!account) return
    setLoading(true)
    try { setStats(await fetchAccountStats(account.id, opts)) }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось получить данные аккаунта', desc: e instanceof Error ? e.message : undefined }) }
    finally { setLoading(false) }
  }, [account, pushToast])

  useEffect(() => {
    if (!account) { setStats(null); return }
    setStats(null) // не показываем данные прежнего аккаунта, пока грузится новый
    if (resetToProfile) setTab('profile')
    void load()
  }, [account?.id])

  const runSpamCheck = async () => {
    setSpamChecking(true)
    try { await load({ spam: true }); pushToast({ type: 'info', title: 'Спамблок проверен через @SpamBot' }) }
    finally { setSpamChecking(false) }
  }

  const runRelease = async () => {
    if (!account) return
    setReleasing(true)
    try {
      const r = await releaseAccountLock(account.id)
      pushToast({ type: 'success', title: r.released ? 'Блокировка снята' : 'Блокировок не было' })
      await loadAccountBusy()
      await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось снять блокировку', desc: e instanceof Error ? e.message : undefined })
    } finally { setReleasing(false) }
  }

  return (
    <div>
      <button onClick={() => navigate('/panel')} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к менеджеру</button>

      <div className="card grid min-h-[560px] gap-0 overflow-hidden p-0 lg:grid-cols-[minmax(240px,300px)_1fr]">
        {/* Слева — список аккаунтов с фильтром (переключение без выхода из обзора). */}
        <div className="flex flex-col border-b border-line lg:border-b-0 lg:border-r">
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="input h-9 w-full pl-9 text-sm"
                placeholder="Поиск аккаунта…"
              />
            </div>
            {/* Видно, что список сужен до выбора, и можно выйти к полному списку не теряя обзор. */}
            {selectedIds && (
              <button
                onClick={() => setOnlySelected((v) => !v)}
                className="mt-2 w-full rounded-lg border border-iris-500/40 bg-iris-500/10 px-2 py-1.5 text-xs text-iris-200 transition-colors hover:bg-iris-500/20"
                title={onlySelected ? 'Показать все аккаунты' : 'Вернуться к выбранным'}
              >
                {onlySelected ? `Только выбранные · ${selectedIds.size} — показать все` : `Показаны все — вернуться к выбранным (${selectedIds.size})`}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto lg:max-h-[calc(100vh-260px)]">
            {filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">Ничего не найдено</p>
            ) : filtered.map((a) => (
              <button
                key={a.id}
                type="button"
                // ?sel= сохраняем при переключении: без него выборка «только выбранные»
                // терялась с ПЕРВОГО же клика, кнопка «Только выбранные · N» исчезала и
                // вернуться к ней было нельзя — а переключение между аккаунтами и есть
                // основной сценарий этого экрана (прогон 21–22.07, тест 3.12).
                onClick={() => navigate(`/panel/accounts/${a.id}${params.get('sel') ? `?sel=${params.get('sel')}` : ''}`)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-line/50 p-3 text-left transition-colors hover:bg-elevated',
                  account?.id === a.id && 'bg-iris-500/10',
                )}
              >
                <Avatar name={a.name} color={a.avatarColor} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">{a.name}</div>
                  <div className="truncate text-xs text-muted">@{a.username}</div>
                </div>
                <StatusBadge status={a.status} />
              </button>
            ))}
          </div>
        </div>

        {/* Справа — те же табы, что были в модалке. */}
        <div className="flex min-h-0 flex-col">
          {!account ? (
            <EmptyState icon={<User size={26} />} title="Нет аккаунтов" desc="Добавьте аккаунт в менеджере." />
          ) : (
            <div className="space-y-4 overflow-y-auto p-4">
              <HeroBanner account={account} stats={stats} />

              <div className="flex gap-1 overflow-x-auto border-b border-line no-scrollbar">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={cn(
                      'relative flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm font-semibold transition-colors',
                      tab === t.key ? 'text-fg' : 'text-muted hover:text-fg',
                    )}
                  >
                    {t.icon}{t.label}
                    {tab === t.key && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-spark-gradient" />}
                  </button>
                ))}
                <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 self-center pl-3 text-[11px] text-muted" title="По умолчанию таб сохраняется при переключении аккаунтов">
                  <input
                    type="checkbox"
                    checked={resetToProfile}
                    onChange={(e) => setResetToProfile(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-line accent-spark-500"
                  />
                  сбрасывать на профиль
                </label>
              </div>

              {loading && !stats ? (
                <div className="flex items-center justify-center gap-2 py-16 text-muted">
                  <Loader2 size={18} className="animate-spin" /> Загрузка данных из Telegram…
                </div>
              ) : (
                <div className="animate-fade-in">
                  {tab === 'profile' && <ProfileTab account={account} stats={stats} />}
                  {tab === 'proxy' && <ProxyTab account={account} stats={stats} loading={loading} onRecheck={() => void load()} />}
                  {tab === 'status' && <StatusTab stats={stats} spamChecking={spamChecking} onSpamCheck={() => void runSpamCheck()} />}
                  {tab === 'dates' && <DatesTab stats={stats} />}
                  {tab === 'actions' && (
                    <ActionsTab
                      stats={stats}
                      loading={loading}
                      spamChecking={spamChecking}
                      releasing={releasing}
                      onRecheck={() => void load()}
                      onSpamCheck={() => void runSpamCheck()}
                      onRelease={() => void runRelease()}
                    />
                  )}
                  {tab === 'health' && <HealthTab stats={stats} accountId={account.id} />}
                  {tab === 'channels' && <ChannelsTab accountId={account.id} />}
                  {tab === 'folders' && <FoldersTab accountId={account.id} />}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
