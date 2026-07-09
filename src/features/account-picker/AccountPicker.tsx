import { useMemo, useState } from 'react'
import {
  Search, Users, CheckCheck, ChevronsRight, ChevronsLeft, RefreshCw, ChevronDown, Inbox, ShieldCheck, Loader2,
} from 'lucide-react'
import { useApp, activeAccounts } from '@/mocks/store'
import { Avatar, Select } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { ROLES, COUNTRIES_FILTER } from '@/shared/config/modules'
import type { TgAccount } from '@/shared/types'

const FLAGS: Record<string, string> = { ua: '🇺🇦', ru: '🇷🇺', kz: '🇰🇿', pl: '🇵🇱', de: '🇩🇪' }
const COUNTRY_NAME: Record<string, string> = { ua: 'UA', ru: 'RU', kz: 'KZ', pl: 'PL', de: 'DE' }

/** Двухпанельный выбор аккаунтов: Доступные | Выбрано. */
export function AccountPicker({
  selected, onChange, actions = ['Добавить все', 'Удалить все'], withFilters = true,
  selectedTitle = 'Выбрано',
}: {
  selected: Set<string>
  onChange: (next: Set<string>) => void
  actions?: string[]
  withFilters?: boolean
  selectedTitle?: string
}) {
  const data = useApp((s) => s.data)
  const pushToast = useApp((s) => s.pushToast)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const accounts = activeAccounts(data)
  const limit = data.plan.accountLimit

  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('Все роли')
  const [country, setCountry] = useState('all')
  const [workingProxies, setWorkingProxies] = useState(true)
  const [hideWorking, setHideWorking] = useState(false)
  const [liteMode, setLiteMode] = useState(false)

  const available = useMemo(
    () => accounts.filter((a) => {
      if (selected.has(a.id)) return false
      if (role !== 'Все роли' && a.role !== role) return false
      if (country !== 'all' && a.country !== country) return false
      if (workingProxies && a.proxy === '—') return false
      if (hideWorking && (a.status === 'working' || a.busyIn)) return false
      if (query && !`${a.name} ${a.username} ${a.phone}`.toLowerCase().includes(query.toLowerCase())) return false
      return true
    }),
    [accounts, selected, role, country, workingProxies, hideWorking, query],
  )

  const busyAvailable = useMemo(() => available.filter((a) => a.busyIn), [available])
  const freeAvailable = useMemo(() => available.filter((a) => !a.busyIn), [available])

  const selectedList = accounts.filter((a) => selected.has(a.id))

  // группировка доступных по стране
  const grouped = useMemo(() => {
    const g: Record<string, TgAccount[]> = {}
    for (const a of freeAvailable) (g[a.country] ||= []).push(a)
    return Object.entries(g)
  }, [freeAvailable])

  const addAll = () => {
    const ids = freeAvailable.map((a) => a.id)
    if (!ids.length) {
      if (busyAvailable.length) {
        pushToast({ type: 'info', title: 'Все свободные аккаунты уже выбраны', desc: `${busyAvailable.length} заняты в других модулях` })
      }
      return
    }
    if (busyAvailable.length) {
      pushToast({ type: 'info', title: 'Пропущены занятые', desc: `${busyAvailable.length} акк. уже в работе — не добавлены` })
    }
    onChange(new Set([...selected, ...ids]))
  }
  const removeAll = () => onChange(new Set())
  const add = (id: string) => {
    const acc = accounts.find((a) => a.id === id)
    if (acc?.busyIn) {
      pushToast({ type: 'error', title: 'Аккаунт занят', desc: `Сейчас в модуле «${acc.busyIn.moduleLabel}». Параллельный запуск запрещён.` })
      return
    }
    onChange(new Set([...selected, id]))
  }
  const remove = (id: string) => { const n = new Set(selected); n.delete(id); onChange(n) }

  return (
    <div className="card p-0">
      {/* Header */}
      <button onClick={() => setCollapsed((v) => !v)} className="flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><Users size={18} /></span>
        <span className="font-display text-base font-bold text-fg">Выбор аккаунтов</span>
        <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{selected.size} выбрано</span>
        <span className="rounded-md bg-elevated px-2 py-0.5 text-xs font-bold text-muted">{selected.size}/{limit}</span>
        <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', collapsed && '-rotate-90')} />
      </button>

      {!collapsed && (
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {/* Available */}
          <div className="rounded-2xl border border-line bg-elevated/40">
            <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-sm font-bold text-fg">Доступные аккаунты</div>
                <div className="text-[11px] text-muted">Свободно: {freeAvailable.length} · Занято: {busyAvailable.length} / {accounts.length}</div>
              </div>
              <button type="button" onClick={() => { void loadAccountBusy(); pushToast({ type: 'info', title: 'Статусы обновлены' }) }} className="btn-icon h-8 w-8"><RefreshCw size={14} /></button>
            </div>

            {withFilters && (
              <div className="space-y-2 border-b border-line p-3">
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Поиск по ID, телефону, username…" />
                </div>
                <div className="flex gap-2">
                  <Select className="flex-1" value={country} onChange={setCountry} options={COUNTRIES_FILTER.map((c) => ({ value: c.code, label: `${c.flag} ${c.label}`.trim() }))} />
                  <Select className="flex-1" value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: r }))} />
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {actions.includes('Добавить все') && <button onClick={addAll} className="btn-soft h-8 text-xs"><ChevronsRight size={14} /> Добавить все</button>}
                  <Check label="Рабочие прокси" checked={workingProxies} onChange={setWorkingProxies} />
                  <Check label="Лайт-режим" checked={liteMode} onChange={setLiteMode} />
                  <Check label="Скрыть рабочие" checked={hideWorking} onChange={setHideWorking} title="Скрыть аккаунты в работе и занятые в других модулях" />
                </div>
              </div>
            )}

            <div className="max-h-80 overflow-y-auto p-2">
              {freeAvailable.length === 0 && busyAvailable.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted">Нет аккаунтов, соответствующих фильтрам</div>
              ) : (
                <>
                  {grouped.map(([code, list]) => (
                    <div key={code} className="mb-2">
                      <div className="flex items-center gap-2 px-2 py-1 text-xs font-bold text-muted">
                        <span>{FLAGS[code]}</span> {COUNTRY_NAME[code] ?? code.toUpperCase()} <span className="text-faint">{list.length}</span>
                      </div>
                      {list.map((a) => (
                        <AccountRow key={a.id} account={a} liteMode={liteMode} onAdd={() => add(a.id)} />
                      ))}
                    </div>
                  ))}
                  {busyAvailable.length > 0 && !hideWorking && (
                    <div className="mt-2 border-t border-line pt-2">
                      <div className="px-2 py-1 text-xs font-bold text-rose-300">В работе · {busyAvailable.length}</div>
                      {busyAvailable.map((a) => (
                        <AccountRow key={a.id} account={a} liteMode={liteMode} busy disabled />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Selected */}
          <div className="rounded-2xl border border-line bg-elevated/40">
            <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-sm font-bold text-fg">{selectedTitle}</div>
                <div className="text-[11px] text-muted">Выбрано: {selected.size}</div>
              </div>
              {actions.includes('Удалить все') && (
                <button onClick={removeAll} disabled={selected.size === 0} className="btn-ghost h-8 text-xs text-rose-300 disabled:opacity-40"><ChevronsLeft size={14} /> Убрать все</button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {selectedList.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl border border-line bg-elevated text-faint"><Inbox size={22} /></div>
                  <div className="text-sm font-semibold text-muted">Аккаунты не выбраны</div>
                </div>
              ) : (
                <div className="space-y-1">
                  {selectedList.map((a) => (
                    <div key={a.id} className={cn('flex items-center gap-2.5 rounded-xl border px-2 py-2', a.busyIn ? 'border-rose-500/40 bg-rose-500/8' : 'border-spark-500/30 bg-spark-500/8')}>
                      <button onClick={() => remove(a.id)} className="btn-icon h-7 w-7 shrink-0 text-rose-300"><ChevronsLeft size={14} /></button>
                      <Avatar name={a.name} color={a.avatarColor} size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-fg">{a.name}</div>
                        <div className="flex items-center gap-1 truncate text-[11px] text-muted">
                          <span className="truncate">@{a.username} · {a.role}</span>
                          {a.busyIn && (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap text-rose-300">
                              · <Loader2 size={10} className="animate-spin" /> занят: {a.busyIn.moduleLabel}
                            </span>
                          )}
                        </div>
                      </div>
                      <MiniBadge tone={a.busyIn ? 'rose' : 'spark'}>{FLAGS[a.country]}</MiniBadge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button type="button" title={title} onClick={() => onChange(!checked)} className={cn('flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-semibold transition-colors', checked ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}>
      <span className={cn('grid h-3.5 w-3.5 place-items-center rounded border', checked ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>{checked && <CheckCheck size={10} />}</span>
      {label}
    </button>
  )
}

function MiniBadge({ children, tone, outline }: { children: React.ReactNode; tone: 'spark' | 'rose'; outline?: boolean }) {
  const tones = {
    spark: outline ? 'border-spark-500/40 text-spark-300' : 'bg-spark-500/15 text-spark-300 border-transparent',
    rose: outline ? 'border-rose-500/40 text-rose-300' : 'bg-rose-500/15 text-rose-300 border-transparent',
  }
  return <span className={cn('inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[9px] font-bold uppercase', tones[tone])}>{children}</span>
}

function AccountRow({ account: a, liteMode, onAdd, busy, disabled }: {
  account: TgAccount; liteMode: boolean; onAdd?: () => void; busy?: boolean; disabled?: boolean
}) {
  return (
    <div className={cn('group flex items-center gap-2.5 rounded-xl px-2 py-2', disabled ? 'opacity-70' : 'hover:bg-elevated')}>
      <Avatar name={a.name} color={a.avatarColor} size={liteMode ? 26 : 32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-fg">{a.name}</div>
        {!liteMode && (
          <div className="flex items-center gap-1 truncate text-[11px] text-muted">
            <span className="truncate">{a.phone.replace('+', '')} <span className="text-iris-300/80">@{a.username}</span></span>
            {a.busyIn && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-rose-300">
                · <Loader2 size={10} className="animate-spin" /> {a.busyIn.moduleLabel}
              </span>
            )}
          </div>
        )}
      </div>
      {!liteMode && (
        <div className="flex shrink-0 items-center gap-1">
          {busy && a.busyIn ? (
            <MiniBadge tone="rose"><Loader2 size={9} className="animate-spin" /> ЗАНЯТ</MiniBadge>
          ) : (
            <>
              {a.status === 'active' && <MiniBadge tone="spark">VALID</MiniBadge>}
              {a.proxy !== '—' && <MiniBadge tone="spark" outline><ShieldCheck size={9} /> Proxy OK</MiniBadge>}
            </>
          )}
        </div>
      )}
      {!disabled && onAdd && (
        <button type="button" onClick={onAdd} className="btn-icon h-7 w-7 shrink-0 text-spark-400"><ChevronsRight size={14} /></button>
      )}
    </div>
  )
}
