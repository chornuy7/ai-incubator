import { useEffect, useRef } from 'react'
import { Outlet, useLocation, Link } from 'react-router-dom'
import { AppSidebar } from '@/widgets/AppSidebar'
import { AppHeader } from '@/widgets/AppHeader'
import { Toasts } from '@/widgets/Toasts'
import { DevPanel } from '@/widgets/DevPanel'
import { TasksDrawer } from '@/widgets/TasksDrawer'
import { HelpCenterDrawer } from '@/widgets/HelpCenterDrawer'
import { PaywallBanner } from '@/features/paywall/Paywall'
import { useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { canAccessPath } from '@/shared/lib/access'
import { useUi } from '@/shared/lib/uiStore'
import { HelpCircle, Lock } from 'lucide-react'

/** Заглушка «нет доступа» — когда роль не имеет доступа к странице (в т.ч. при заходе по прямому URL). */
function AccessDenied() {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/12 text-rose-300"><Lock size={26} /></div>
      <h2 className="font-display text-lg font-bold text-fg">Нет доступа к разделу</h2>
      <p className="mt-1.5 text-sm text-muted">Ваша роль не имеет доступа к этой странице. Обратитесь к администратору, чтобы он выдал доступ в «Роли и доступы».</p>
      <Link to="/panel/support" className="btn-primary mt-5 inline-flex h-10">В поддержку</Link>
    </div>
  )
}

export function Layout() {
  const mobileNavOpen = useApp((s) => s.mobileNavOpen)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const isNoSub = useApp((s) => s.userState === 'no-sub')
  const loadAccounts = useApp((s) => s.loadAccounts)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const sessionUser = useSession((s) => s.user)
  const location = useLocation()
  const helpOpen = useUi((s) => s.helpOpen)
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)

  // Guard: гейтим и прямой заход по URL, не только меню (§8.1). Демо (без сессии) — всё открыто.
  const routeAllowed = !sessionUser || canAccessPath(sessionUser.permissions, sessionUser.isAdmin, location.pathname)

  // При открытом Help Center ужимаем контент вправо (padding-right = ширина дровера 28rem),
  // чтобы панель не перекрывала контент. Только на lg+ (≥1024px); на мобиле дровер поверх.
  // Применяется к отдельному враппер-div (без Tailwind-паддинга), чтобы inline-стиль не конфликтовал
  // с Tailwind important:true (lg:px-8 на <main> перебить нельзя).
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    // Ужимаем ширину контента на ширину дровера (28rem). Через width (не padding/margin —
    // они конфликтуют с flex/Tailwind important в этом layout). Контент прижат влево, дровер справа.
    const apply = () => { el.style.width = helpOpen && window.innerWidth >= 1024 ? 'calc(100% - 28rem)' : '' }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [helpOpen])

  const openHelp = () => {
    setHelpTopic('Помощь по настройкам')
    setHelpOpen(true)
  }

  useEffect(() => {
    void loadAccounts()
    void loadAccountBusy()
    const id = setInterval(() => void loadAccountBusy(), 4000)
    return () => clearInterval(id)
  }, [loadAccounts, loadAccountBusy])

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-[80] lg:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setMobileNav(false)} />
          <div className="absolute left-0 top-0 h-full animate-fade-in">
            <AppSidebar mobile />
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div ref={contentRef} className="help-shift">
            {isNoSub && <PaywallBanner />}
            {routeAllowed ? <Outlet /> : <AccessDenied />}
          </div>
        </main>
      </div>

      <Toasts />
      <DevPanel />
      <TasksDrawer />
      <button
        type="button"
        onClick={openHelp}
        className="fixed right-5 top-24 z-[97] grid h-11 w-11 place-items-center rounded-full bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.04]"
        aria-label="Help Center"
        title="Help Center"
      >
        <HelpCircle size={18} />
      </button>
      <HelpCenterDrawer />
    </div>
  )
}
