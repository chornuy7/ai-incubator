import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { AppSidebar } from '@/widgets/AppSidebar'
import { AppHeader } from '@/widgets/AppHeader'
import { Toasts } from '@/widgets/Toasts'
import { DevPanel } from '@/widgets/DevPanel'
import { TasksDrawer } from '@/widgets/TasksDrawer'
import { PaywallBanner } from '@/features/paywall/Paywall'
import { useApp } from '@/mocks/store'

export function Layout() {
  const mobileNavOpen = useApp((s) => s.mobileNavOpen)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const isNoSub = useApp((s) => s.userState === 'no-sub')
  const loadAccounts = useApp((s) => s.loadAccounts)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)

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
          {isNoSub && <PaywallBanner />}
          <Outlet />
        </main>
      </div>

      <Toasts />
      <DevPanel />
      <TasksDrawer />
    </div>
  )
}
