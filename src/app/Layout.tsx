import { useEffect } from 'react'
import { Outlet, useLocation, Link } from 'react-router-dom'
import { AppSidebar } from '@/widgets/AppSidebar'
import { AppHeader } from '@/widgets/AppHeader'
import { Toasts } from '@/widgets/Toasts'
import { DialogHost } from '@/widgets/DialogHost'
import { DevPanel } from '@/widgets/DevPanel'
import { TasksDrawer } from '@/widgets/TasksDrawer'
import { HelpCenterDrawer } from '@/widgets/HelpCenterDrawer'
import { SupportWidget } from '@/widgets/SupportWidget'
import { PaywallBanner } from '@/features/paywall/Paywall'
import { LowBalanceBar } from '@/features/billing/LowBalanceBar'
import { ImpersonationBar } from '@/features/auth/ImpersonationBar'
import { LowBalanceLoginModal } from '@/features/billing/LowBalanceLoginModal'
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
  // MR-52: ширина сайдбара как CSS-переменная — чтобы плавающие кнопки (Help/Поддержка)
  // прижимались к правому краю КОНТЕНТА (max-w-1400 внутри колонки после сайдбара), а не
  // к краю окна: на любом разрешении они у контента и не налезают на него.
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const sessionUser = useSession((s) => s.user)
  const location = useLocation()
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)

  // Guard: гейтим и прямой заход по URL, не только меню (§8.1). Демо (без сессии) — всё открыто.
  const routeAllowed = !sessionUser || canAccessPath(sessionUser.permissions, sessionUser.isAdmin, location.pathname, sessionUser.isOwner, sessionUser.isSub)

  const openHelp = () => {
    setHelpTopic('Помощь по настройкам')
    setHelpOpen(true)
  }

  /**
   * «Кто сейчас занят задачей» нужен ТОЛЬКО там, где на экране аккаунты: менеджер,
   * пикер при запуске модуля, дашборд задач. Раньше этот опрос молотил раз в 4 секунды
   * на ЛЮБОЙ странице — на «Прокси» это был бесконечный поток запросов ни за чем
   * (замечание заказчика 12.08). Плюс он не замирал на скрытой вкладке.
   */
  const needsBusy = /^\/panel(\/(accounts|modules|tasks|automation)\b|\/?$)/.test(location.pathname)

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    if (!needsBusy) return
    void loadAccountBusy()
    const id = setInterval(() => {
      // Вкладка свёрнута — не дёргаем сервер: обновим, когда на неё вернутся.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void loadAccountBusy()
    }, 10000)
    return () => clearInterval(id)
  }, [needsBusy, loadAccountBusy])

  return (
    <div className="flex min-h-screen" style={{ '--sidebar-w': sidebarCollapsed ? '76px' : '256px' } as React.CSSProperties}>
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
      {/* data-main-column — по нему нижняя панель запуска меряет свою ширину. Ей нужна
          ВСЯ рабочая область (MR-56: «панель на всю ширину»), а не колонка контента с
          капом 1400px: контент ограничиваем, панель — нет. */}
      <div data-main-column className="flex min-w-0 flex-1 flex-col">
        {/* §10.1: лента низкого баланса — в самом верху, над шапкой, без крестика. */}
        {/* §5.3 (MR-36): видно, что кабинет чужой, и есть выход обратно в админку. */}
        <ImpersonationBar />
        <LowBalanceBar />
        <AppHeader />
        {/* ТЗ 19.08 §5 — регрессия ширины. Кап 1400px тут был на ВСЕХ страницах, пока MR-129
            не снял его для роута карточки аккаунта («карточка на всю ширину»): страница
            стала растягиваться по экрану и разъезжаться с шапкой, у которой кап остался
            (AppHeader: max-w-[1400px]). Возвращаем единую колонку-блок для всех роутов —
            как в дашборде задач.

            Колонку держит отдельная обёртка, а не сам <main>. Нижняя панель запуска к
            этой обёртке НЕ привязана: она меряет [data-main-column] — всю рабочую
            область. Кап 1400px для контента и «панель на всю ширину» (MR-56) — разные
            требования, и раньше панель сжималась заодно с контентом. */}
        <div className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-1 flex-col">
          {/*
            Нижний отступ на высоту панели запуска (правка владельца 26.08: «перекрывает
            результаты поиска, больше места вниз нужно дать»).

            Панель фиксирована у низа экрана, а место под неё резервировала распорка ВНУТРИ
            себя — то есть там, где панель объявлена в разметке. Во всех трёх витринах она
            объявлена ДО последней секции, поэтому пустое место оказывалось в середине
            страницы, а низ уезжал под панель. Резерв на уровне страницы работает независимо
            от того, где панель стоит в дереве; высоту она сама публикует в --launch-bar-h.
          */}
          <main className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8" style={{ paddingBottom: 'calc(1.5rem + var(--launch-bar-h, 0px))' }}>
            {isNoSub && <PaywallBanner />}
            {routeAllowed ? <Outlet /> : <AccessDenied />}
          </main>
        </div>
      </div>

      {/* Help Center — сайдбар в потоке: сужает страницу, а не оверлеит (§3.1). */}
      <HelpCenterDrawer />
      <LowBalanceLoginModal />

      <Toasts />
      <DialogHost />
      <DevPanel />
      <TasksDrawer />
      <button
        type="button"
        onClick={openHelp}
        // §8 (MR-46): кнопка Help Center опущена вниз — в правый нижний угол, над виджетом
        // поддержки (раньше висела вверху справа и налезала на контент шапки).
        // bottom считаем от высоты нижней панели запуска (переменная от FloatingBar):
        // в модулях кнопка поднимается над панелью и больше на неё не налезает.
        style={{ bottom: 'calc(var(--launch-bar-h, 0px) + 3.75rem)', right: 'clamp(1rem, calc((100vw - var(--sidebar-w, 0px) - 1400px) / 2 - 1rem), 4rem)' }}
        className="fixed z-[97] grid h-10 w-10 place-items-center rounded-full border border-line bg-elevated/95 text-spark-300 shadow-pop backdrop-blur transition-transform hover:scale-[1.04]"
        aria-label="Help Center"
        title="Help Center"
      >
        <HelpCircle size={16} />
      </button>
      {/* §8 (MR-45): быстрая поддержка — правый нижний угол, отдельно от Help Center. */}
      <SupportWidget />
    </div>
  )
}
