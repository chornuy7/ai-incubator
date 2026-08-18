import { create } from 'zustand'
import type { RolePermissions } from '@/api/rolesApi'
import { logoutUser, fetchMe, type User } from '@/api/usersApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'

const LS_KEY = 'ai-incubator:session'
// MR-141: метка последней активности пользователя — для локального тайм-аута сессии по
// бездействию (без запросов в БД). Обновляется на реальных действиях (SessionGuard) и
// сбрасывается в «сейчас» при входе, чтобы свежая сессия не вылетела по старой метке.
export const ACTIVITY_KEY = 'ai-incubator:activity'
export function markActivity(now = Date.now()) { try { localStorage.setItem(ACTIVITY_KEY, String(now)) } catch { /* ignore */ } }

export interface SessionUser {
  id: string
  email: string
  name: string
  roleId: string
  roleIds: string[]
  roleName: string
  isAdmin: boolean
  /** §4.1 (MR-29): владелец рабочего пространства (есть субпользователи) → доступна «Команда». */
  isOwner: boolean
  /** Суб-пользователь: работает в чужом пространстве, подписку не оформляет. */
  isSub: boolean
  permissions: RolePermissions | null
}

interface SessionStore {
  user: SessionUser | null
  login: (user: User, role: { id: string; name: string; permissions: RolePermissions } | null, isOwner?: boolean) => void
  logout: () => void
  /** Перечитать права с сервера (см. `fetchMe`). Тихо: сбой сети не выкидывает из сессии. */
  refresh: () => Promise<void>
}

function persist(user: SessionUser | null) {
  try {
    if (user) localStorage.setItem(LS_KEY, JSON.stringify(user))
    else localStorage.removeItem(LS_KEY)
  } catch { /* ignore quota */ }
}

function boot(): SessionUser | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as SessionUser) : null
  } catch { return null }
}

export const useSession = create<SessionStore>((set) => ({
  user: boot(),
  login: (user, role, isOwner = false) => {
    const roleIds = user.roleIds?.length ? user.roleIds : (user.roleId ? [user.roleId] : [])
    const su: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      roleIds,
      roleName: role?.name ?? '',
      isAdmin: user.roleId === ADMIN_BYPASS_ID || roleIds.includes(ADMIN_BYPASS_ID),
      isOwner,
      isSub: !!user.parentId,
      permissions: role?.permissions ?? null,
    }
    persist(su)
    markActivity() // MR-141: свежая сессия → отсчёт бездействия с нуля
    set({ user: su })
  },
  refresh: async () => {
    const cur = useSession.getState().user
    if (!cur) return
    try {
      const { user, role, isOwner } = await fetchMe()
      const roleIds = user.roleIds?.length ? user.roleIds : (user.roleId ? [user.roleId] : [])
      const su: SessionUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        roleIds,
        roleName: role?.name ?? '',
        isAdmin: user.roleId === ADMIN_BYPASS_ID || roleIds.includes(ADMIN_BYPASS_ID),
        isOwner,
        isSub: !!user.parentId,
        permissions: role?.permissions ?? null,
      }
      persist(su)
      set({ user: su })
    } catch { /* сеть/сервер лёг — работаем на прежних правах, а не выкидываем человека */ }
  },
  logout: () => {
    const uid = useSession.getState().user?.id
    if (uid) void logoutUser(uid) // clock-out рабочего времени (§8.1)
    persist(null)
    try { localStorage.removeItem(ACTIVITY_KEY) } catch { /* ignore */ } // MR-141: сбрасываем метку бездействия
    // MR-142 (баг 1): при выходе из панели снимаем и админ-гейт — иначе «Выйти» из панели
    // оставлял бы админку разблокированной под тем же браузером.
    lockAdminGate()
    set({ user: null })
    // MR-142 (баг 1): чистим память приложения жёсткой перезагрузкой. Иначе после входа
    // под другим аккаунтом в модульных кэшах (цены, стор) остаются данные прошлой сессии —
    // «тянутся старые данные прошлой БД». Полный boot гарантирует чистое состояние.
    try { window.location.assign('/') } catch { /* SSR/тест — просто пропускаем */ }
  },
}))

/**
 * MR-142 (баг 2, созвон 12.08): вход в панель и в админку — ДВЕ РАЗНЫЕ авторизации.
 *
 * Раньше `/admin` открывался автоматически, если в панельной сессии был админ: панель и
 * админка «шарили» один вход, и попасть в пульт со всеми деньгами/людьми можно было, просто
 * зайдя в панель. Заказчик: «адмін панель повинна мати окремий доступ». Поэтому вход в
 * админку теперь отдельный гейт: панельная сессия сама по себе его НЕ открывает — нужен
 * явный вход через форму /admin. Ключ отдельный, снимается при выходе из любой из зон.
 */
const ADMIN_GATE_KEY = 'ai-incubator:admin'
function readAdminGate(): boolean { try { return !!localStorage.getItem(ADMIN_GATE_KEY) } catch { return false } }
export function lockAdminGate() { try { localStorage.removeItem(ADMIN_GATE_KEY) } catch { /* ignore */ } }

interface AdminGateStore { unlocked: boolean; unlock: () => void; lock: () => void }
export const useAdminGate = create<AdminGateStore>((set) => ({
  unlocked: readAdminGate(),
  unlock: () => { try { localStorage.setItem(ADMIN_GATE_KEY, '1') } catch { /* ignore */ } set({ unlocked: true }) },
  lock: () => { lockAdminGate(); set({ unlocked: false }) },
}))
