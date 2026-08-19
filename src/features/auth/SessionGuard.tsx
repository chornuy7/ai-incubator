import { useEffect } from 'react'
import { useSession, markActivity, ACTIVITY_KEY } from './session'

/**
 * MR-141 (созвон 12.08): локальный сторож сессии. Всё делает НА КЛИЕНТЕ, без запросов в
 * БД — держать сессию живой должны действия пользователя, а не фоновые опросы.
 *
 *  1. Тайм-аут по бездействию: нет действий пользователя 2.5 ч → выкидываем на логин.
 *     Активность считаем ТОЛЬКО по реальным жестам (клик/клавиша/скролл/тач), а не по
 *     фоновым запросам (иначе 5-секундный поллинг задач держал бы сессию вечно).
 *  2. Живость сессии: каждые ~15 c проверяем, что сессия ещё в localStorage (вышли в
 *     другой вкладке / очистили — «кука умерла») и что подписанный токен не просрочен
 *     (его `exp` читается локально из самого токена, без обращения к серверу).
 *
 * Сторож ПАНЕЛЬНЫЙ: монтируется в авторизованной ветке панели и работает с панельной
 * сессией/токеном. Админка — отдельная сессия (useAdminSession) и здесь не участвует.
 * Компонент невидимый — только эффекты. Монтируется один раз в корне приложения.
 */
const IDLE_MS = 2.5 * 60 * 60 * 1000 // «2–3 ч без активности» — берём середину
const CHECK_MS = 15_000 // локальная проверка каждые ~15 c (как просил заказчик)
const LS_SESSION = 'ai-incubator:session'
const LS_TOKEN = 'ai-incubator:token'

/** Срок годности подписанного токена `base64url(uid).exp.hmac` — читаем `exp` локально. */
function tokenExpired(token: string, now: number): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false // дев без секрета: токена нет / не тот формат — не трогаем
  const exp = Number(parts[1])
  return Number.isFinite(exp) && now > exp
}

export function SessionGuard() {
  const user = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)

  // (1) Отмечаем активность на реальных жестах пользователя.
  useEffect(() => {
    if (!user) return
    if (!localStorage.getItem(ACTIVITY_KEY)) markActivity() // первый визит без метки
    const mark = () => markActivity()
    const events: (keyof WindowEventMap)[] = ['mousedown', 'keydown', 'touchstart', 'scroll']
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, mark))
  }, [user])

  // (1)+(2) Периодическая локальная проверка: тайм-аут по бездействию + живость токена.
  useEffect(() => {
    if (!user) return
    const check = () => {
      const now = Date.now()
      // (2) «Кука умерла»: подписанный токен (прод) просрочен — читаем его `exp` ЛОКАЛЬНО,
      // без запроса на сервер. Обновление прав (refresh) токен не трогает, так что здесь
      // он надёжный признак живости, в отличие от записи сессии.
      try {
        const token = localStorage.getItem(LS_TOKEN)
        if (token && tokenExpired(token, now)) { logout(); return }
      } catch { /* ignore */ }
      // (1) Тайм-аут по бездействию — без запросов в БД, только по локальной метке.
      let last = 0
      try { last = Number(localStorage.getItem(ACTIVITY_KEY)) || 0 } catch { /* ignore */ }
      if (last && now - last > IDLE_MS) { logout(); return }
    }
    check()
    const id = window.setInterval(check, CHECK_MS)
    return () => window.clearInterval(id)
  }, [user, logout])

  // (2b) Кросс-табный выход: вышли/очистили сессию или токен в ДРУГОЙ вкладке — событие
  // `storage` прилетает сюда, выкидываем и здесь. Работает одинаково в панели и в админке.
  useEffect(() => {
    if (!user) return
    const onStorage = (e: StorageEvent) => {
      if ((e.key === LS_SESSION || e.key === LS_TOKEN) && e.newValue === null) logout()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [user, logout])

  // Админка теперь ОТДЕЛЬНАЯ сессия (см. useAdminSession) — панельный сторож её не трогает.
  // Прежний пункт «сменили аккаунт панели на не-админский → запереть админку» больше не нужен.

  return null
}
