import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Users, CheckCheck, ChevronsRight, ChevronsLeft, RefreshCw, ChevronDown, Inbox, Loader2, Lock, AlertTriangle, Settings,
} from 'lucide-react'
import { useApp, activeAccounts, isBrokenAccount, hasProxyIssue } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { Avatar, Select } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { filterAccountsByAccess } from '@/shared/lib/access'
import { fetchAccountGroups, type AccountGroup } from '@/api/accountGroupsApi'
import { cn } from '@/shared/lib/utils'
import { ROLES } from '@/shared/config/modules'
import { WARMING_MODULES } from '@/shared/lib/massAction'
import { countryOptionsFrom, matchesGeo, FLAGS } from '@/shared/config/geo'
import type { TgAccount } from '@/shared/types'

/**
 * Занят ли аккаунт ДЛЯ ЭТОГО модуля.
 *
 * Правка 22.08 (прогон на живых аккаунтах). Раньше здесь стояло «занят любой
 * блокировкой» — и многомодульность, которой посвящён отдельный пункт ТЗ, через
 * интерфейс была недоступна: аккаунт, комментирующий в одном модуле, второй модуль
 * показывал в «Недоступны». Сервер при этом многомодульность РАЗРЕШАЕТ и специально
 * отдаёт фронту список модулей-держателей (`server/tgAccounts.js`, комментарий «чтобы
 * форма блокировала только совпадение по СВОЕМУ модулю») — форма этим не пользовалась.
 *
 * Запрещаем ровно два случая:
 *   • аккаунт уже занят ЭТИМ же модулем — две задачи одного модуля на один профиль
 *     не имеют смысла и дерутся за один слот;
 *   • среди держателей есть ПРОГРЕВ — он исключающий (§3.3 ТЗ): пока профиль греется,
 *     он ничем другим не занимается.
 *
 * Без `moduleKey` (общие экраны — автоматизация, кампания) ведём себя как раньше:
 * там «для какого модуля» неизвестно, и осторожность важнее.
 */
const holdersOf = (a: TgAccount) => a.busyIn?.modules?.length
  ? a.busyIn.modules.map((m) => m.moduleKey)
  : (a.busyIn ? [a.busyIn.moduleKey] : [])

const isBusy = (a: TgAccount, moduleKey?: string) => {
  if (a.status === 'working' && !a.busyIn) return true // занят без известного держателя
  const holders = holdersOf(a)
  if (!holders.length) return false
  if (!moduleKey) return true
  return holders.includes(moduleKey) || holders.some((k) => WARMING_MODULES.has(k))
}
// §3.2/§5.1: непрогретые/нерабочие статусы нельзя назначать в работу.
const NON_RUNNABLE = new Set(['warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid', 'frozen'])
const STATUS_RU: Record<string, string> = {
  warming: 'в прогреве', pause: 'на паузе', floodwait: 'FloodWait', quarantine: 'в карантине',
  spamblock: 'спамблок', reauth: 'нужна авторизация', invalid: 'невалидный', frozen: 'заморожен',
}
const statusBlocks = (a: TgAccount) => NON_RUNNABLE.has(a.status)
const isUnavailable = (a: TgAccount, moduleKey?: string) => isBusy(a, moduleKey) || statusBlocks(a)
/** Реальная причина недоступности для бейджа/тултипа (не общее «ЗАНЯТ»). */
const isWorking = (a: TgAccount, moduleKey?: string) => isBusy(a, moduleKey)
// MR-132: конкретная причина, а не общее «недоступен» — человек должен понимать, что именно.
const unavailLabel = (a: TgAccount, moduleKey?: string) => {
  // Занят ЭТИМ же модулем или прогревом — называем модуль: «В работе» ничего не объясняет,
  // когда рядом стоят аккаунты, занятые другим модулем и при этом доступные.
  if (isWorking(a, moduleKey)) {
    const label = a.busyIn?.modules?.length
      ? a.busyIn.modules.map((m) => m.moduleLabel).join(', ')
      : a.busyIn?.moduleLabel
    return label ? `занят: ${label}` : 'В работе'
  }
  if (a.noProxy) return 'нет прокси'
  if (a.proxyOk === false) return 'прокси не отвечает'
  return STATUS_RU[a.status] || 'недоступен'
}

/** Двухпанельный выбор аккаунтов: Доступные | Выбрано. */
export function AccountPicker({
  selected, onChange, actions = ['Добавить все', 'Удалить все'], withFilters = true,
  selectedTitle = 'Выбрано', moduleKey,
}: {
  selected: Set<string>
  onChange: (next: Set<string>) => void
  actions?: string[]
  withFilters?: boolean
  /**
   * Для какого модуля выбираем. Нужен для многомодульности: аккаунт, занятый ДРУГИМ
   * модулем, для этого — свободен. Без ключа (кампания, автоматизация) считаем занятым
   * любого держателя, как раньше.
   */
  moduleKey?: string
  selectedTitle?: string
}) {
  const data = useApp((s) => s.data)
  const pushToast = useApp((s) => s.pushToast)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const navigate = useNavigate()
  // MR-132: сломанный из-за прокси аккаунт чиним переходом в Менеджер → таб «Прокси»
  // (не дублируем настройки прокси в пикере — только ссылка).
  const fixProxy = (id: string) => navigate(`/panel/accounts/${id}?card=proxy`)
  const sessionUser = useSession((s) => s.user)
  // §12: группы нужны, чтобы доступ роли «на группу» действительно применялся к пикеру.
  const [accGroups, setAccGroups] = useState<AccountGroup[]>([])
  useEffect(() => { if (sessionUser && !sessionUser.isAdmin) void fetchAccountGroups().then(({ groups }) => setAccGroups(groups)).catch(() => {}) }, [sessionUser])
  // R4: не-админ видит только выданные его роли аккаунты (без сессии/демо — все).
  const accounts = sessionUser
    ? filterAccountsByAccess(activeAccounts(data), sessionUser.permissions, sessionUser.isAdmin, accGroups)
    : activeAccounts(data)
  const limit = data.plan.accountLimit

  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('Все роли')
  const [country, setCountry] = useState('all')
  const [workingProxies, setWorkingProxies] = useState(false)
  const [liteMode, setLiteMode] = useState(false)
  // §6.3 (AM-003): раскрытие нижней панели «Показать нерабочие (N)» (по умолчанию свёрнута).
  const [showBroken, setShowBroken] = useState(false)

  const available = useMemo(
    () => accounts.filter((a) => {
      if (selected.has(a.id)) return false
      if (role !== 'Все роли' && a.role !== role) return false
      if (!matchesGeo(a.country, country)) return false
      if (workingProxies && a.proxy === '—') return false
      // §6.3 (AM-002): id включён в поиск, чтобы «нерабочий» аккаунт находился по ID даже когда он скрыт.
      const q = query.trim().toLowerCase()
      if (q && !`${a.name} ${a.username} ${a.phone} ${a.id}`.toLowerCase().includes(q)) return false
      // §6.3 (AM-002/003): нерабочие (мёртвый прокси / нерабочий статус) не в основном списке —
      // они в нижней панели «Показать нерабочие». При явном поиске показываем (найти по ID/имени).
      if (isBrokenAccount(a) && !q) return false
      return true
    }),
    [accounts, selected, role, country, workingProxies, query],
  )

  // §6.3 (AM-003): список нерабочих для нижней раскрывающейся панели «Показать нерабочие (N)».
  const brokenList = useMemo(
    () => accounts.filter((a) => !selected.has(a.id) && isBrokenAccount(a) && matchesGeo(a.country, country) && (role === 'Все роли' || a.role === role)),
    [accounts, selected, country, role],
  )

  const busyAvailable = useMemo(() => available.filter((a) => isUnavailable(a, moduleKey)), [available, moduleKey])
  /*
   * Сверху — те, кого можно взять ПРЯМО СЕЙЧАС и ни от кого не отрывая; ниже — те, кто
   * уже трудится в другом модуле (просьба владельца 24.08).
   *
   * Взять их можно: аккаунт работает в нескольких модулях сразу (решение 20.08), поэтому
   * в «Недоступны» они не попадают. Но выбирать в первую очередь надо не их — иначе
   * оператор набирает задачу из самых загруженных профилей, а простаивающие так и стоят.
   * Сортировка устойчивая: внутри каждой группы порядок остаётся прежним.
   */
  const freeAvailable = useMemo(() => {
    const list = available.filter((a) => !isUnavailable(a, moduleKey))
    return [...list].sort((x, y) => Number(holdersOf(x).length > 0) - Number(holdersOf(y).length > 0))
  }, [available, moduleKey])
  /** Сколько из верхней группы уже заняты в других модулях — для подписи-разделителя. */
  const busyElsewhere = useMemo(() => freeAvailable.filter((a) => holdersOf(a).length > 0).length, [freeAvailable])

  // Сколько аккаунтов скрыто именно фильтром «Рабочие прокси» (прямое подключение, без прокси).
  const hiddenByProxy = useMemo(() => {
    if (!workingProxies) return 0
    return accounts.filter((a) => {
      if (selected.has(a.id)) return false
      if (role !== 'Все роли' && a.role !== role) return false
      if (!matchesGeo(a.country, country)) return false
      if (query && !`${a.name} ${a.username} ${a.phone}`.toLowerCase().includes(query.toLowerCase())) return false
      return a.proxy === '—'
    }).length
  }, [accounts, selected, role, country, query, workingProxies])

  const selectedList = accounts.filter((a) => selected.has(a.id))

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
    if (acc && isBusy(acc, moduleKey)) {
      const holders = acc.busyIn?.modules?.length ? acc.busyIn.modules.map((m) => m.moduleLabel).join(', ') : acc.busyIn?.moduleLabel
      const прогрев = holdersOf(acc).some((k) => WARMING_MODULES.has(k))
      pushToast({
        type: 'error',
        title: 'Аккаунт занят',
        desc: прогрев
          ? 'Идёт прогрев — пока он не закончится, аккаунт не берут другие модули.'
          : holders ? `Уже работает в «${holders}» этим же модулем — вторая задача на тот же профиль не запускается.` : 'Аккаунт в работе — выбрать нельзя.',
      })
      return
    }
    if (acc && statusBlocks(acc)) {
      pushToast({ type: 'error', title: 'Профиль недоступен', desc: `Аккаунт ${STATUS_RU[acc.status] || acc.status} — назначить в работу нельзя. Дождитесь возврата в «активные».` })
      return
    }
    onChange(new Set([...selected, id]))
  }
  const remove = (id: string) => { const n = new Set(selected); n.delete(id); onChange(n) }

  return (
    <div className="card relative p-0">
      {/* #10: помощь по блоку — абсолютно, чтобы не вкладывать кнопку в кнопку */}
      <div className="absolute right-3 top-3 z-10"><HelpButton topic="Выбор аккаунтов" /></div>
      {/* Header */}
      <button onClick={() => setCollapsed((v) => !v)} className="flex w-full items-center gap-3 border-b border-line px-4 py-3.5 pr-14 text-left">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><Users size={18} /></span>
        <span className="font-display text-base font-bold text-fg">Выбор аккаунтов</span>
        {/* MR-101 (UI-003): один счётчик в формате «2 из 50». */}
        <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{selected.size} из {limit}</span>
        {/* MR-136: метка «обязательно» — как у блока «Группы» (без аккаунтов запуск невозможен). */}
        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300" title="Без выбора аккаунтов запуск недоступен">обязательно</span>
        <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', collapsed && '-rotate-90')} />
      </button>

      {!collapsed && (
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {/* Available */}
          <div className="rounded-2xl border border-line bg-elevated/40">
            <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-sm font-bold text-fg">Доступные аккаунты</div>
                <div className="text-[11px] text-muted">Свободно: {freeAvailable.length} из {accounts.length}</div>
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
                  <Select className="flex-1" value={country} onChange={setCountry} options={countryOptionsFrom(accounts.map((a) => a.country)).map((c) => ({ value: c.code, label: `${c.flag} ${c.label}`.trim() }))} />
                  <Select className="flex-1" value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: r }))} />
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {actions.includes('Добавить все') && <button onClick={addAll} className="btn-soft h-8 text-xs"><ChevronsRight size={14} /> Добавить все</button>}
                  <Check label="Рабочие прокси" checked={workingProxies} onChange={setWorkingProxies} />
                  <Check label="Лайт-режим" checked={liteMode} onChange={setLiteMode} />
                </div>
              </div>
            )}

            {hiddenByProxy > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{hiddenByProxy} акк. скрыто фильтром «Рабочие прокси» (прямое подключение).</span>
                <button type="button" onClick={() => setWorkingProxies(false)} className="ml-auto rounded-md border border-amber-500/40 bg-amber-500/12 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-500/20">Показать их</button>
              </div>
            )}

            <div className="max-h-80 overflow-y-auto p-2">
              {freeAvailable.length === 0 && busyAvailable.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted">Нет аккаунтов, соответствующих фильтрам</div>
              ) : (
                <>
                  {/* MR-101 (UI-003): плоский список без заголовков-стран (страна видна флажком в строке;
                      фильтр по стране остаётся в dropdown «Все страны»). */}
                  {freeAvailable.map((a, i) => {
                    // Тонкая черта там, где кончаются простаивающие и начинаются занятые
                    // в других модулях: без неё порядок выглядит случайным.
                    const first = busyElsewhere > 0 && i === freeAvailable.length - busyElsewhere
                    return (
                      <div key={a.id}>
                        {first && (
                          <div className="mt-2 border-t border-line px-2 pb-1 pt-2 text-xs font-semibold text-muted">
                            Заняты в других модулях · {busyElsewhere}
                            <span className="ml-1 font-normal text-faint">— взять можно, аккаунт работает в нескольких модулях</span>
                          </div>
                        )}
                        <AccountRow account={a} liteMode={liteMode} moduleKey={moduleKey} onAdd={() => add(a.id)} />
                      </div>
                    )
                  })}
                  {busyAvailable.length > 0 && (
                    <div className="mt-2 border-t border-line pt-2">
                      <div className="px-2 py-1 text-xs font-bold text-rose-300">Недоступны · {busyAvailable.length}</div>
                      {busyAvailable.map((a) => (
                        <AccountRow key={a.id} account={a} liteMode={liteMode} moduleKey={moduleKey} busy disabled />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {/* §6.3 (AM-003): нижняя раскрывающаяся панель «Показать нерабочие (N)» — свёрнута по умолчанию,
                нерабочие не предлагаются для запуска. При активном поиске они уже в основном списке. */}
            {brokenList.length > 0 && !query.trim() && (
              <div className="border-t border-line">
                <button type="button" onClick={() => setShowBroken((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-rose-300 hover:bg-rose-500/[.06]">
                  <ChevronDown size={14} className={cn('shrink-0 transition-transform', !showBroken && '-rotate-90')} />
                  Показать нерабочие ({brokenList.length})
                  <span className="ml-auto hidden truncate font-normal text-muted sm:block">без прокси / мёртвый прокси / нерабочий статус — не для запуска</span>
                </button>
                {showBroken && (
                  <div className="max-h-64 overflow-y-auto px-2 pb-2">
                    {brokenList.map((a) => (
                      <AccountRow key={a.id} account={a} liteMode={liteMode} moduleKey={moduleKey} busy disabled onFixProxy={hasProxyIssue(a) ? () => fixProxy(a.id) : undefined} />
                    ))}
                  </div>
                )}
              </div>
            )}
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

function AccountRow({ account: a, liteMode, onAdd, busy, disabled, onFixProxy, moduleKey }: {
  account: TgAccount; liteMode: boolean; onAdd?: () => void; busy?: boolean; disabled?: boolean; onFixProxy?: () => void
  /** Для какого модуля выбираем — от этого зависит, считается ли аккаунт занятым. */
  moduleKey?: string
}) {
  return (
    <div
      // MR-132: строка сломанного из-за прокси аккаунта кликабельна целиком — ведёт в
      // Менеджер → Прокси (шестерёнка, не замок): проблему можно починить, а не «нельзя».
      onClick={onFixProxy}
      title={onFixProxy
        ? 'Нет рабочего прокси — открыть Менеджер → Прокси и назначить'
        : disabled ? `${unavailLabel(a, moduleKey)} — выбрать нельзя` : undefined}
      className={cn('group flex items-center gap-2.5 rounded-xl px-2 py-2',
        onFixProxy ? 'cursor-pointer hover:bg-iris-500/10' : disabled ? 'cursor-not-allowed select-none opacity-60' : 'hover:bg-elevated')}
    >
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
      {/* MR-132: вместо избыточных VALID/Proxy OK показываем осмысленное — статус и Доверие
          (как в менеджере), а для занятых/нерабочих — конкретную причину недоступности. */}
      {!liteMode && (
        <div className="flex shrink-0 items-center gap-1">
          {busy ? (
            <MiniBadge tone="rose">{isWorking(a, moduleKey) ? <><Loader2 size={9} className="animate-spin" /> {unavailLabel(a, moduleKey)}</> : unavailLabel(a, moduleKey)}</MiniBadge>
          ) : (
            <MiniBadge tone="spark"><span className="h-1.5 w-1.5 rounded-full bg-current" /> Активные</MiniBadge>
          )}
        </div>
      )}
      {onFixProxy ? (
        // MR-132: шестерёнка вместо замка — прокси можно назначить, это не «нельзя».
        <button type="button" onClick={(e) => { e.stopPropagation(); onFixProxy() }} title="Назначить прокси в Менеджере" className="btn-icon h-7 w-7 shrink-0 text-iris-300"><Settings size={14} /></button>
      ) : disabled ? (
        <Lock size={14} className="shrink-0 text-rose-300/70" />
      ) : (
        onAdd && <button type="button" onClick={onAdd} className="btn-icon h-7 w-7 shrink-0 text-spark-400"><ChevronsRight size={14} /></button>
      )}
    </div>
  )
}
