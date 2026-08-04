import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Play, Pause, Square, RefreshCw, Wifi, WifiOff, Trash2, RotateCcw, Upload, X } from 'lucide-react'
import { Card, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp } from '@/mocks/store'
import { fetchAccounts, setAccountStatusManual, releaseAccountLock, patchAccount, deleteAccount, emptyTrashApi } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { STATUS_LABEL_RU } from './MonitoringTab'
// §5.2 (MR-35): та же карточка аккаунта, что и в user-панели — полная информация
// (профиль/работа/прокси) и действия. Не дублируем, переиспользуем один компонент.
import { AccountManagementModal } from '@/features/account-manager/AccountManagementModal'

/**
 * §10.10: управление аккаунтами из sudo-админки — полный список ВСЕХ аккаунтов
 * (сервер не скоупит их по юзеру, стор общий) с ключевыми действиями: пауза/запуск,
 * «стоп» (снять лок задачи) и корзина (мягкое удаление/восстановление/очистка).
 * Тяжёлый мастер импорта (сессии/прокси-ферма) не дублируем — ведём в Менеджер профилей.
 */
const TONE: Record<string, string> = {
  floodwait: 'text-amber-300', quarantine: 'text-amber-300', warming: 'text-amber-200',
  spamblock: 'text-red-300', invalid: 'text-red-300', reauth: 'text-iris-300', pause: 'text-muted',
}
const bandTone = (b?: string) => (b === 'high' ? 'text-spark-300' : b === 'mid' ? 'text-amber-300' : b === 'low' ? 'text-red-300' : 'text-muted')

export function AccountsTab() {
  const pushToast = useApp((s) => s.pushToast)
  const [accounts, setAccounts] = useState<TgAccount[] | null>(null)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // §10.10: корзина прямо в админке — чтобы не ходить в Менеджер профилей за
  // восстановлением/удалением. 'live' — рабочие, 'trash' — удалённые.
  const [view, setView] = useState<'live' | 'trash'>('live')
  // §5.2 (MR-35): выбранный аккаунт для карточки-деталей (клик по строке).
  const [detailAcc, setDetailAcc] = useState<TgAccount | null>(null)
  const nav = useNavigate()

  const load = async () => {
    setLoading(true)
    try { setAccounts(await fetchAccounts()) }
    catch { pushToast({ type: 'error', title: 'Не удалось загрузить аккаунты' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const live = useMemo(() => (accounts || []).filter((a) => !a.inTrash), [accounts])
  const trashed = useMemo(() => (accounts || []).filter((a) => a.inTrash), [accounts])
  const byStatus = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of live) m[a.status] = (m[a.status] || 0) + 1
    return m
  }, [live])

  const source = view === 'trash' ? trashed : live
  const needle = q.trim().toLowerCase()
  const rows = source.filter((a) => {
    if (view === 'live' && statusFilter !== 'all' && a.status !== statusFilter) return false
    if (!needle) return true
    return [a.name, a.phone, a.username].some((v) => (v || '').toLowerCase().includes(needle))
  })

  const act = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(id)
    try {
      const r = await fn()
      if (r.ok) { pushToast({ type: 'success', title: okMsg }); await load() }
      else pushToast({ type: 'error', title: 'Не удалось', desc: r.error })
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy(null) }
  }
  const pause = (a: TgAccount) => act(a.id, () => setAccountStatusManual(a.id, 'pause'), `${a.name} — на паузе`)
  const resume = (a: TgAccount) => act(a.id, () => setAccountStatusManual(a.id, 'active'), `${a.name} — запущен`)
  const stop = (a: TgAccount) => act(a.id, async () => ({ ok: (await releaseAccountLock(a.id)).ok }), `${a.name} — освобождён`)
  // §10.10: корзина. «В корзину» — мягкое удаление (inTrash), обратимо; «Удалить
  // навсегда» — отвязывает сессию, необратимо, поэтому с подтверждением.
  const toTrash = (a: TgAccount) => act(a.id, async () => ({ ok: (await patchAccount(a.id, { inTrash: true }))?.ok !== false }), `${a.name} — в корзине`)
  const restore = (a: TgAccount) => act(a.id, async () => ({ ok: (await patchAccount(a.id, { inTrash: false }))?.ok !== false }), `${a.name} — восстановлен`)
  const removeForever = (a: TgAccount) => {
    if (!window.confirm(`Удалить «${a.name}» навсегда? Сессия аккаунта будет отвязана — это необратимо.`)) return
    void act(a.id, async () => ({ ok: (await deleteAccount(a.id))?.ok !== false }), `${a.name} — удалён навсегда`)
  }
  const emptyTrash = () => {
    if (!trashed.length || !window.confirm(`Очистить корзину? ${trashed.length} аккаунт(ов) будут удалены навсегда.`)) return
    void act('__trash__', async () => { await emptyTrashApi(); return { ok: true } }, 'Корзина очищена')
  }

  if (!accounts) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!live.length && !trashed.length) return <EmptyState icon={<Wifi size={22} />} title="Аккаунтов нет" desc="Добавьте аккаунты в менеджере профилей." />

  return (
    <div className="space-y-3">
      {/* Переключатель Рабочие/Корзина + импорт */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line p-0.5">
          <button onClick={() => setView('live')}
            className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', view === 'live' ? 'bg-spark-500/12 text-spark-200' : 'text-muted hover:text-fg')}>
            Рабочие <b className={view === 'live' ? 'text-spark-100' : 'text-fg'}>{live.length}</b>
          </button>
          <button onClick={() => setView('trash')}
            className={cn('inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors', view === 'trash' ? 'bg-red-500/12 text-red-200' : 'text-muted hover:text-fg')}>
            <Trash2 size={13} /> Корзина <b className={view === 'trash' ? 'text-red-100' : 'text-fg'}>{trashed.length}</b>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {view === 'trash' && !!trashed.length && (
            <button onClick={emptyTrash} disabled={!!busy}
              className="inline-flex items-center gap-1 rounded-xl border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40">
              <X size={14} /> Очистить корзину
            </button>
          )}
          {/* Импорт — тяжёлый мастер (сессии/прокси) живёт в Менеджере профилей; не дублируем, ведём туда. */}
          <button onClick={() => nav('/panel')}
            className="inline-flex items-center gap-1 rounded-xl border border-line px-3 py-1.5 text-xs text-muted hover:border-spark-500/40 hover:text-fg">
            <Upload size={14} /> Импорт аккаунтов
          </button>
        </div>
      </div>

      {/* Панель: поиск + обновить */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, телефон, @username" className="input h-9 w-full pl-9 text-sm" />
        </div>
        <span className="text-xs text-muted">Показано: <b className="text-fg">{rows.length}</b> из {source.length}</span>
        <button onClick={() => void load()} disabled={loading} className="btn-ghost h-9 rounded-xl border border-line px-3 text-sm disabled:opacity-40">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Обновить
        </button>
      </div>

      {/* Фильтр по статусу — только для рабочих */}
      {view === 'live' && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setStatusFilter('all')}
            className={cn('rounded-lg border px-2 py-1 text-xs transition-colors', statusFilter === 'all' ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
            Все <b className="text-fg">{live.length}</b>
          </button>
          {Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([st, n]) => (
            <button key={st} onClick={() => setStatusFilter(st)}
              className={cn('rounded-lg border px-2 py-1 text-xs transition-colors', statusFilter === st ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
              {STATUS_LABEL_RU[st] || st} <b className="text-fg">{n}</b>
            </button>
          ))}
        </div>
      )}

      {/* Таблица */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2.5 font-medium">Аккаунт</th>
              <th className="px-3 py-2.5 font-medium">Статус</th>
              <th className="px-3 py-2.5 font-medium">Trust</th>
              <th className="px-3 py-2.5 font-medium">Прокси</th>
              <th className="px-3 py-2.5 font-medium">Занят</th>
              <th className="px-4 py-2.5 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const paused = a.status === 'pause'
              return (
                <tr key={a.id} className="border-b border-line/40 last:border-0">
                  <td className="px-4 py-2.5">
                    {/* Клик по аккаунту открывает ту же карточку деталей, что и в user-панели (MR-35). */}
                    <button onClick={() => setDetailAcc(a)} title="Открыть карточку аккаунта" className="group flex items-center gap-2.5 text-left">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-elevated text-[11px] font-bold text-muted">{(a.name || '?')[0]}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fg group-hover:text-spark-200">{a.name}</span>
                        <span className="block truncate text-[11px] text-muted">{a.phone || a.username || '—'}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={cn('font-medium', TONE[a.status] || 'text-spark-300')}>{STATUS_LABEL_RU[a.status] || a.status}</span>
                    {!!a.statusReason && <span className="block max-w-[160px] truncate text-[10px] text-faint">{a.statusReason}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {a.trustScore != null ? <span className={cn('tabular-nums font-semibold', bandTone(a.trustBand))}>{a.trustScore}</span> : <span className="text-faint">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {a.proxy ? <Wifi size={15} className="text-spark-400" /> : <WifiOff size={15} className="text-faint" />}
                  </td>
                  <td className="px-3 py-2.5">
                    {a.busyIn ? <span className="rounded-md bg-iris-500/12 px-1.5 py-0.5 text-[11px] font-medium text-iris-200">{a.busyIn.moduleLabel}</span> : <span className="text-xs text-muted">свободен</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {view === 'trash' ? (
                        <>
                          <button onClick={() => void restore(a)} disabled={busy === a.id}
                            className="inline-flex items-center gap-1 rounded-lg border border-spark-500/40 bg-spark-500/10 px-2 py-1 text-xs text-spark-200 hover:bg-spark-500/15 disabled:opacity-40">
                            <RotateCcw size={12} /> Восстановить
                          </button>
                          <button onClick={() => removeForever(a)} disabled={busy === a.id}
                            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-40">
                            <Trash2 size={12} /> Навсегда
                          </button>
                        </>
                      ) : (
                        <>
                          {a.busyIn && (
                            <button onClick={() => void stop(a)} disabled={busy === a.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-40">
                              <Square size={12} /> Стоп
                            </button>
                          )}
                          {paused ? (
                            <button onClick={() => void resume(a)} disabled={busy === a.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-spark-500/40 bg-spark-500/10 px-2 py-1 text-xs text-spark-200 hover:bg-spark-500/15 disabled:opacity-40">
                              <Play size={12} /> Запустить
                            </button>
                          ) : (
                            <button onClick={() => void pause(a)} disabled={busy === a.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40">
                              <Pause size={12} /> Пауза
                            </button>
                          )}
                          <button onClick={() => void toTrash(a)} disabled={busy === a.id} title="В корзину"
                            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-40">
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {!rows.length && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">Ничего не найдено по фильтру.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Карточка аккаунта из user-панели: полная информация + действия (MR-35).
          После закрытия перезагружаем список — внутри могли снять лок/сменить статус. */}
      <AccountManagementModal account={detailAcc} onClose={() => { setDetailAcc(null); void load() }} />
    </div>
  )
}
