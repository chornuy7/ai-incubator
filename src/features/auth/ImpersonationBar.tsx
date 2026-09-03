import { Eye, LogOut } from 'lucide-react'
import { IMPERSONATE_KEY, PANEL_SESSION_KEY, PANEL_TOKEN_KEY } from './zone'

/**
 * §5.3 (MR-36): панель открыта ГЛАЗАМИ клиента — из админки, кнопкой «Войти под клиентом».
 *
 * Полоса нужна не для красоты: без неё владелец через пять минут забудет, чей кабинет
 * перед ним, и решит, что это баг его собственной панели. Плюс отсюда единственный
 * честный выход — сессию клиента надо стереть, а не просто закрыть вкладку.
 */
export function ImpersonationBar() {
  let who = ''
  try { who = localStorage.getItem(IMPERSONATE_KEY) || '' } catch { /* приватный режим */ }
  if (!who) return null

  const leave = () => {
    try {
      localStorage.removeItem(IMPERSONATE_KEY)
      localStorage.removeItem(PANEL_SESSION_KEY)
      localStorage.removeItem(PANEL_TOKEN_KEY)
    } catch { /* ignore */ }
    // Жёсткая перезагрузка: в памяти приложения остались данные чужого кабинета.
    try { window.location.assign('/admin') } catch { /* SSR/тест */ }
  }

  return (
    /*
     * Липкая и ВЫШЕ модалок (z-[110] против z-[100]). Иначе выйти нельзя: у клиента без
     * подписки панель сразу накрывается модалкой-заглушкой, и она перекрывает эту полосу.
     * Владелец должен видеть то же, что клиент, — но путь назад обязан оставаться живым.
     */
    <div className="sticky top-0 z-[110] flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-iris-500/30 bg-iris-600/95 px-4 py-2 text-sm backdrop-blur">
      <span className="flex items-center gap-1.5 font-semibold text-white">
        <Eye size={15} /> Вы смотрите панель под клиентом
      </span>
      <span className="text-white/85">{who}</span>
      <button onClick={leave} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/40 px-3 text-xs font-semibold text-white hover:bg-white/15">
        <LogOut size={13} /> Выйти и вернуться в админку
      </button>
    </div>
  )
}
