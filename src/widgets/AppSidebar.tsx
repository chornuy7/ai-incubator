import { NavLink, useLocation } from 'react-router-dom'
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { ROUTES, GROUP_LABELS, type RouteDef } from '@/shared/config/routes'
import { useApp } from '@/mocks/store'
import { cn } from '@/shared/lib/utils'

const GROUP_ORDER: RouteDef['group'][] = ['main', 'modules', 'parsing', 'account']

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-spark-gradient shadow-[0_4px_16px_-4px_rgba(14,196,100,0.6)]">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 3c3.6 0 6.2 3.7 6.2 7.8 0 3.4-2.8 6.2-6.2 6.2s-6.2-2.8-6.2-6.2C5.8 6.7 8.4 3 12 3Z" stroke="#04150c" strokeWidth="1.8" />
          <path d="M9.4 11l1.9 2.4L15 8.6" stroke="#04150c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {!collapsed && (
        <div className="min-w-0 leading-tight">
          <div className="font-display text-[15px] font-bold text-fg">AI Incubator</div>
          <div className="text-[11px] font-medium text-muted">панель управления</div>
        </div>
      )}
    </div>
  )
}

export function AppSidebar({ mobile = false }: { mobile?: boolean }) {
  const collapsed = useApp((s) => s.sidebarCollapsed) && !mobile
  const toggle = useApp((s) => s.toggleSidebar)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const location = useLocation()

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-r border-line bg-surface/80 backdrop-blur-xl transition-[width] duration-200',
        mobile ? 'w-72' : 'sticky top-0',
        collapsed ? 'w-[76px]' : 'w-64',
      )}
    >
      <div className="flex h-16 items-center justify-between px-4">
        <Logo collapsed={collapsed} />
        {mobile ? (
          <button onClick={() => setMobileNav(false)} className="btn-icon" aria-label="Закрыть меню">
            <X size={18} />
          </button>
        ) : (
          <button onClick={toggle} className="btn-icon hidden lg:inline-flex" aria-label="Свернуть меню">
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 no-scrollbar">
        {GROUP_ORDER.map((group) => {
          const items = ROUTES.filter((r) => r.group === group)
          return (
            <div key={group} className="mb-4">
              {!collapsed && (
                <div className="px-3 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider text-faint">
                  {GROUP_LABELS[group]}
                </div>
              )}
              <div className="space-y-0.5">
                {items.map((r) => {
                  const active = location.pathname === r.path
                  const Icon = r.icon
                  return (
                    <NavLink
                      key={r.path}
                      to={r.path}
                      onClick={() => mobile && setMobileNav(false)}
                      title={collapsed ? r.label : undefined}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                        collapsed && 'justify-center',
                        active
                          ? 'bg-spark-500/12 text-spark-300'
                          : 'text-muted hover:bg-elevated hover:text-fg',
                      )}
                    >
                      {active && <span className="absolute left-0 h-5 w-1 rounded-r-full bg-spark-gradient" />}
                      <Icon size={19} className="shrink-0" />
                      {!collapsed && <span className="truncate">{r.label}</span>}
                      {!collapsed && r.badge && (
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
          <div className="rounded-xl border border-line bg-elevated p-3">
            <div className="text-xs font-semibold text-fg">Демо-режим</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted">
              Все данные — моки. Ничего не отправляется на сервер.
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
