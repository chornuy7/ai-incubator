import { useEffect, useState, useCallback, useMemo } from 'react'
import { WorkTab } from './WorkTab'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { User, Loader2, ArrowLeft, Search } from 'lucide-react'
import { Avatar, StatusBadge, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp, activeAccounts } from '@/mocks/store'
import { fetchAccountStats, releaseAccountLock } from '@/api/accountsApi'
import type { AccountStats } from '@/shared/types'
import { useTabParam } from '@/shared/lib/useTabParam'
import {
  TABS, HeroBanner, ProfileTab, ProxyTab, HealthTab, ChannelsTab,
  type TabKey,
} from './AccountManagementModal'

/**
 * §3: обзор аккаунта — ВЬЮШКА, а не модалка поверх списка (модалка перегружала экран).
 * Раскладка как почта/WhatsApp: слева колонка аккаунтов с фильтром, справа — те же табы.
 *
 * Выбранный таб СОХРАНЯЕТСЯ при переключении аккаунтов (useTabParam, в URL) — так удобно
 * сравнивать одно и то же у разных профилей. MR-129: галочку «сбрасывать на профиль» убрали.
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

  // MR-129 (10.08): вкладка ВСЕГДА сохраняется при переключении аккаунтов — галочку «сбрасывать» убрали.
  const [tab, setTab] = useTabParam<TabKey>('profile', 'card')
  const [stats, setStats] = useState<AccountStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [spamChecking, setSpamChecking] = useState(false)
  const [releasing, setReleasing] = useState(false)

  const load = useCallback(async (opts?: { spam?: boolean }): Promise<AccountStats | null> => {
    if (!account) return null
    setLoading(true)
    try { const s = await fetchAccountStats(account.id, opts); setStats(s); return s }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось получить данные аккаунта', desc: e instanceof Error ? e.message : undefined }); return null }
    finally { setLoading(false) }
  }, [account, pushToast])

  useEffect(() => {
    if (!account) { setStats(null); return }
    setStats(null) // не показываем данные прежнего аккаунта, пока грузится новый
    void load()
  }, [account?.id])

  // MR-129: проверка прокси с явным результатом-тостом (раньше клик «Проверить» ничего не сообщал).
  const runProxyCheck = async () => {
    const s = await load()
    if (!s) return
    const px = s.proxy
    if (!px.configured) pushToast({ type: 'info', title: 'Прокси не настроен', desc: 'Аккаунт подключается напрямую' })
    else if (px.working) pushToast({ type: 'success', title: 'Прокси работает', desc: `${px.protocol ?? ''} ${px.ip ?? ''}:${px.port ?? ''}`.trim() })
    else pushToast({ type: 'error', title: 'Прокси не отвечает', desc: 'Смените прокси на рабочий' })
  }

  const runSpamCheck = async () => {
    setSpamChecking(true)
    try {
      const s = await load({ spam: true })
      if (!s) return // ошибка сети уже показана в load()
      // MR-129: не рапортуем «проверено», если живой проверки не было (мёртвый прокси/сессия).
      if (!s.status.sessionOk) {
        pushToast({ type: 'error', title: 'Спамблок не проверен', desc: 'Прокси не отвечает или сессия недоступна — назначьте рабочий прокси' })
        return
      }
      const sb = s.status.spamblock
      if (sb === 'blocked') pushToast({ type: 'error', title: 'Обнаружен спамблок', desc: s.status.spamblockText || 'Аккаунт ограничен @SpamBot' })
      else if (sb === 'clean') pushToast({ type: 'success', title: 'Спамблок не найден — чисто', desc: 'Проверено через @SpamBot' })
      else pushToast({ type: 'info', title: 'Спамблок: результат неизвестен', desc: 'Не удалось получить ответ @SpamBot' })
    } finally { setSpamChecking(false) }
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
    // MR-129: карточка на всю ширину, но справа резервируем «коридор» под плавающие кнопки
    // (Help/Поддержка), чтобы они не налезали на кнопки строк (копировать/выйти) и низ шапки.
    <div className="lg:pr-16 xl:pr-20">
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
                // Сохраняем ВСЕ query-параметры при переключении: и ?sel= (выборка «только
                // выбранные»), и ?card= (активная вкладка). Раньше тянули только sel, поэтому
                // вкладка сбрасывалась на «Профиль» при каждом переключении аккаунта (MR-129).
                onClick={() => { const qs = params.toString(); navigate(`/panel/accounts/${a.id}${qs ? `?${qs}` : ''}`) }}
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
                {/* MR-129: в левом списке тоже показываем «Зона риска» (как в менеджере), а не
                    голый статус — иначе аккаунт с мёртвым/отсутствующим прокси выглядел «Активным». */}
                {a.risk && a.risk.level !== 'none'
                  ? <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">Зона риска</span>
                  : <StatusBadge status={a.status} />}
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
              <HeroBanner
                account={account}
                stats={stats}
                actions={{
                  loading, spamChecking, releasing,
                  onRecheck: () => void load(),
                  onSpamCheck: () => void runSpamCheck(),
                  onRelease: () => void runRelease(),
                }}
              />

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
              </div>

              {loading && !stats ? (
                <div className="flex items-center justify-center gap-2 py-16 text-muted">
                  <Loader2 size={18} className="animate-spin" /> Загрузка данных из Telegram…
                </div>
              ) : (
                <div className="animate-fade-in">
                  {tab === 'profile' && <ProfileTab account={account} stats={stats} />}
                  {tab === 'work' && <WorkTab accountId={account.id} />}
                  {tab === 'proxy' && <ProxyTab account={account} stats={stats} loading={loading} onRecheck={() => void runProxyCheck()} />}
                  {tab === 'health' && <HealthTab stats={stats} accountId={account.id} />}
                  {tab === 'channels' && <ChannelsTab accountId={account.id} />}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
