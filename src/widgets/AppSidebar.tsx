import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { fetchTicketsUnread } from '@/api/ticketsApi'
import { X, LogOut, ChevronDown } from 'lucide-react'
import { ROUTES, GROUP_LABELS, type RouteDef } from '@/shared/config/routes'
import { useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { canAccessPath, anyModuleKeyFromPath } from '@/shared/lib/access'
import { usePlan, planHasModule } from '@/features/billing/plan'
import { cn } from '@/shared/lib/utils'

const GROUP_ORDER: RouteDef['group'][] = ['main', 'modules', 'parsing', 'account']

/** Страницы группы «Парсинг», которые не являются модулями и не имеют своей цены. */
const PARSING_HELPER_PATHS = new Set(['/panel/channels', '/panel/parsing-history'])

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    // Клик по логотипу ведёт на лендинг (как «домой» на большинстве сайтов). Путь
    // /landing, а не «/», потому что «/» у авторизованного уходит на панель.
    <Link to="/landing" className="flex items-center gap-2.5 rounded-xl transition-opacity hover:opacity-80" title="На лендинг">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-spark-gradient shadow-[0_4px_16px_-4px_rgba(14,196,100,0.6)]">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 3c3.6 0 6.2 3.7 6.2 7.8 0 3.4-2.8 6.2-6.2 6.2s-6.2-2.8-6.2-6.2C5.8 6.7 8.4 3 12 3Z" stroke="#04150c" strokeWidth="1.8" />
          <path d="M9.4 11l1.9 2.4L15 8.6" stroke="#04150c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {!collapsed && (
        <div className="min-w-0 leading-tight">
          <div className="font-display text-[15px] font-bold text-fg">Murmex</div>
          <div className="text-[11px] font-medium text-muted">панель управления</div>
        </div>
      )}
    </Link>
  )
}

export function AppSidebar({ mobile = false }: { mobile?: boolean }) {
  const collapsed = useApp((s) => s.sidebarCollapsed) && !mobile
  // Правка 14.08: подсказка свёрнутого пункта — через портал с position:fixed, иначе
  // overflow-y-auto у nav обрезает её справа. Держим label + вертикальную позицию.
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const sessionUser = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)
  const setUserState = useApp((s) => s.setUserState)
  const location = useLocation()
  const planModules = usePlan((s) => s.modules)
  // §10 (MR-50): сворачиваемые группы меню — чтобы одновременно видимых пунктов было меньше.
  // Свёрнутые группы храним в localStorage; группа с активной страницей всегда открыта.
  const NAV_LS = 'ai-incubator:nav-collapsed'
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(NAV_LS) || '[]')) } catch { return new Set() }
  })
  const toggleGroup = (g: string) => setClosedGroups((prev) => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    try { localStorage.setItem(NAV_LS, JSON.stringify([...next])) } catch { /* quota */ }
    return next
  })

  const signOut = () => { logout(); setUserState('guest') }

  // Уведомления поддержки: сколько НЕПРОЧИТАННЫХ для моей стороны (клиент видит ответы
  // поддержки; роль «Поддержка» — новые обращения). Красный значок на пункте «Поддержка».
  // Роль «Поддержка» (без админки) смотрит сторону поддержки; остальные — свою.
  const supportSide = !!(sessionUser?.permissions?.resources?.support === 'allow' && !sessionUser?.isAdmin)
  const [supportUnread, setSupportUnread] = useState(0)
  useEffect(() => {
    let alive = true
    const tick = () => {
      // Скрытая вкладка — не опрашиваем: значок всё равно никто не видит.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void fetchTicketsUnread(supportSide).then((n) => { if (alive) setSupportUnread(n) })
    }
    tick()
    const id = setInterval(tick, 60000)
    return () => { alive = false; clearInterval(id) }
  }, [supportSide])

  // Две независимые оси. РОЛЬ (§8.1) — что админ разрешил сотруднику. ПОДПИСКА
  // (§5.4) — что рабочее пространство оплатило: «купив нейрочатінг — бачить
  // нейрочатінг», остальных модулей в меню быть не должно. Проходить надо обе:
  // админ не увидит неоплаченный модуль, а сотрудник — оплаченный, но закрытый ему.
  // MR-157: пока не куплен НИ ОДИН модуль (пустой набор / незарегистрированный) — показываем
  // ВСЕ модули как промо (клик → панель «купить доступ»). Купили ≥1 — прячем неоплаченные.
  const ownsNoModules = Array.isArray(planModules) && planModules.length === 0
  // Подсобные страницы парсинга — база каналов и логи парсинга — сами модулями не
  // являются, поэтому проверку подписки они проходили насквозь. Купив нейродиалоги,
  // человек получал в меню раздел «Парсинг» с двумя пунктами, которых не покупал
  // (правка 18.08). Привязываем их к семье: есть хоть один парсер — есть и они.
  const hasAnyParser = planModules === 'all'
    || (Array.isArray(planModules) && planModules.some((k) => k === 'parsing' || k.startsWith('parsing-')))
  const allowed = (r: RouteDef) => {
    const mk = anyModuleKeyFromPath(r.path)
    if (mk && !ownsNoModules && !planHasModule(planModules, mk)) return false
    if (PARSING_HELPER_PATHS.has(r.path) && !ownsNoModules && !hasAnyParser) return false
    if (!sessionUser) return true
    return canAccessPath(sessionUser.permissions, sessionUser.isAdmin, r.path, sessionUser.isOwner)
  }

  return (
    <aside
      className={cn(
        'relative flex h-screen flex-col border-r border-line bg-surface/80 backdrop-blur-xl transition-[width] duration-200',
        mobile ? 'w-72' : 'sticky top-0',
        collapsed ? 'w-[76px]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center px-4', collapsed && !mobile && 'justify-center')}>
        <Logo collapsed={collapsed} />
        {mobile && (
          <button onClick={() => setMobileNav(false)} className="btn-icon ml-auto" aria-label="Закрыть меню">
            <X size={18} />
          </button>
        )}
      </div>

      {/* Правка 14.08: кнопка сворачивания переехала в верхнюю шапку (AppHeader) — на краю
          сайдбара её было почти не видно. */}

      <nav className="flex-1 overflow-y-auto px-3 pb-4 no-scrollbar">
        {GROUP_ORDER.map((group, gi) => {
          // §10 (MR-49): `!r.hidden` убирает скрытые разделы из меню (маршрут жив).
          const items = ROUTES.filter((r) => r.group === group && !r.hidden && allowed(r))
          if (items.length === 0) return null
          // «Внутри группы» — не только точное совпадение: страницы вида
          // /panel/accounts/:id и /panel/modules/:key должны подсвечивать свою группу.
          // Для корневого /panel сравниваем строго, иначе он совпал бы со всем подряд.
          const hasActive = items.some((r) => (
            r.path === location.pathname || (r.path !== '/panel' && location.pathname.startsWith(r.path + '/'))
          ))
          // В icon-режиме групп не сворачиваем (заголовков нет). Раньше группа с активной
          // страницей ПРИНУДИТЕЛЬНО оставалась открытой — из-за этого свернуть её было
          // нельзя, и группировка «не работала» именно там, где человек сейчас находится.
          // Теперь сворачивается любая, а где ты — видно по зелёному заголовку.
          const groupOpen = collapsed ? true : !closedGroups.has(group)
          return (
            <div key={group} className="mb-4">
              {/* Правка 14.08: в свёрнутом меню заголовков групп нет — рисуем разделитель,
                  иначе иконки сливаются и непонятно, где заканчивается одна группа. */}
              {collapsed && gi > 0 && <div className="mx-2 mb-3 border-t border-line/70" />}
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  title={hasActive ? 'Вы сейчас в этой группе' : undefined}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-3 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider transition-colors',
                    // Зелёный заголовок = текущая страница внутри этой группы. Нужен
                    // прежде всего у СВЁРНУТОЙ группы: пункт скрыт, а понять, где ты,
                    // всё равно надо.
                    hasActive ? 'text-spark-300' : 'text-faint hover:text-muted',
                  )}
                >
                  <ChevronDown size={12} className={cn('shrink-0 transition-transform', !groupOpen && '-rotate-90')} />
                  {GROUP_LABELS[group]}
                  {/* Точка — маркер «ты здесь», когда сам пункт спрятан под свёрнутой группой. */}
                  {hasActive && !groupOpen && <span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-spark-400" />}
                </button>
              )}
              <div className={cn('space-y-0.5', !groupOpen && 'hidden')}>
                {items.map((r) => {
                  // Вложенные страницы (/panel/accounts/:id, /panel/tasks/:id) тоже
                  // подсвечивают свой пункт — иначе на них меню выглядит «нигде».
                  const active = r.path === location.pathname
                    || (r.path !== '/panel' && location.pathname.startsWith(r.path + '/'))
                  const Icon = r.icon
                  return (
                    <NavLink
                      key={r.path}
                      to={r.path}
                      onClick={() => { if (mobile) setMobileNav(false); setTip(null) }}
                      onMouseEnter={(e) => { if (collapsed) { const rc = e.currentTarget.getBoundingClientRect(); setTip({ label: r.label, top: rc.top + rc.height / 2, left: rc.right + 10 }) } }}
                      onMouseLeave={() => setTip(null)}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                        collapsed && 'justify-center',
                        active
                          ? 'bg-spark-500/12 text-spark-300'
                          // MR-137: `muted` — «серый», второстепенный пункт: приглушён, но кликабелен.
                          : r.muted
                            ? 'text-faint opacity-60 hover:bg-elevated hover:text-muted hover:opacity-100'
                            : 'text-muted hover:bg-elevated hover:text-fg',
                      )}
                    >
                      {active && <span className="absolute left-0 h-5 w-1 rounded-r-full bg-spark-gradient" />}
                      <Icon size={19} className="shrink-0" />
                      {/* Красный значок непрочитанного на «Поддержке». В свёрнутом меню — точка. */}
                      {r.path === '/panel/support' && supportUnread > 0 && (
                        collapsed
                          ? <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-surface" />
                          : null
                      )}
                      {!collapsed && <span className="truncate">{r.label}</span>}
                      {!collapsed && r.path === '/panel/support' && supportUnread > 0 ? (
                        <span className="ml-auto grid min-w-[20px] place-items-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {supportUnread}
                        </span>
                      ) : !collapsed && r.badge && (
                        <span className="ml-auto rounded bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">
                          {r.badge}
                        </span>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      {!collapsed && (
        <div className="border-t border-line p-3">
          {sessionUser ? (
            <div className="rounded-xl border border-line bg-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-fg">{sessionUser.name}</div>
                  <div className="truncate text-[11px] text-muted">{sessionUser.email}</div>
                </div>
                <button onClick={signOut} className="btn-icon h-8 w-8 shrink-0" aria-label="Выйти" title="Выйти"><LogOut size={15} /></button>
              </div>
              <div className="mt-2">
                <span className={cn(
                  'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                  sessionUser.isAdmin ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300',
                )}>
                  {sessionUser.isAdmin ? 'Администратор' : `Роль: ${sessionUser.roleName || '—'}`}
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-elevated p-3">
              <div className="text-xs font-semibold text-fg">Демо-режим</div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted">Все данные — моки.</div>
            </div>
          )}
        </div>
      )}
      {/* Правка 14.08: подсказка свёрнутого пункта — порталом (position:fixed), не обрезается nav. */}
      {tip && collapsed && !mobile && createPortal(
        <span
          className="pointer-events-none fixed z-[200] -translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-fg shadow-xl"
          style={{ top: tip.top, left: tip.left }}
        >
          {tip.label}
        </span>,
        document.body,
      )}
    </aside>
  )
}
