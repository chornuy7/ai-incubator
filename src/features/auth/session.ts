import { create } from 'zustand'
import type { RolePermissions } from '@/api/rolesApi'
import { logoutUser, fetchMe, type User } from '@/api/usersApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'

const LS_KEY = 'ai-incubator:session'

export interface SessionUser {
  id: string
  email: string
  name: string
  roleId: string
  roleIds: string[]
  roleName: string
  isAdmin: boolean
  permissions: RolePermissions | null
}

interface SessionStore {
  user: SessionUser | null
  login: (user: User, role: { id: string; name: string; permissions: RolePermissions } | null) => void
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
  login: (user, role) => {
    const roleIds = user.roleIds?.length ? user.roleIds : (user.roleId ? [user.roleId] : [])
    const su: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      roleIds,
      roleName: role?.name ?? '',
      isAdmin: user.roleId === ADMIN_BYPASS_ID || roleIds.includes(ADMIN_BYPASS_ID),
      permissions: role?.permissions ?? null,
    }
    persist(su)
    set({ user: su })
  },
  refresh: async () => {
    const cur = useSession.getState().user
    if (!cur) return
    try {
      const { user, role } = await fetchMe()
      const roleIds = user.roleIds?.length ? user.roleIds : (user.roleId ? [user.roleId] : [])
      const su: SessionUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        roleIds,
        roleName: role?.name ?? '',
        isAdmin: user.roleId === ADMIN_BYPASS_ID || roleIds.includes(ADMIN_BYPASS_ID),
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
    set({ user: null })
  },
}))
