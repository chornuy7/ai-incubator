import { create } from 'zustand'
import type { RolePermissions } from '@/api/rolesApi'
import { logoutUser, fetchMe, type User } from '@/api/usersApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { PANEL_SESSION_KEY, PANEL_TOKEN_KEY, ADMIN_SESSION_KEY, ADMIN_TOKEN_KEY } from './zone'

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

function toSessionUser(
  user: User,
  role: { id: string; name: string; permissions: RolePermissions } | null,
  isOwner: boolean,
): SessionUser {
  const roleIds = user.roleIds?.length ? user.roleIds : (user.roleId ? [user.roleId] : [])
  return {
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
}

/**
 * Фабрика стора сессии для ОДНОЙ зоны (панель ИЛИ админка). У каждой зоны своя запись
 * сессии и свой токен (см. zone.ts), поэтому логин/выход зон независимы: «Выйти» из панели
 * не трогает админку и наоборот. `trackActivity` — только панель ведёт метку бездействия
 * (MR-141); `redirectTo` — куда уходим после выхода из этой зоны.
 */
function createSessionStore(opts: { sessionKey: string; tokenKey: string; redirectTo: string; trackActivity: boolean }) {
  const persist = (user: SessionUser | null) => {
    try {
      if (user) localStorage.setItem(opts.sessionKey, JSON.stringify(user))
      else localStorage.removeItem(opts.sessionKey)
    } catch { /* ignore quota */ }
  }
  const boot = (): SessionUser | null => {
    try {
      const raw = localStorage.getItem(opts.sessionKey)
      return raw ? (JSON.parse(raw) as SessionUser) : null
    } catch { return null }
  }
  return create<SessionStore>((set, get) => ({
    user: boot(),
    login: (user, role, isOwner = false) => {
      const su = toSessionUser(user, role, isOwner)
      persist(su)
      if (opts.trackActivity) markActivity() // MR-141: свежая сессия → отсчёт бездействия с нуля
      set({ user: su })
    },
    refresh: async () => {
      const cur = get().user
      if (!cur) return
      try {
        const { user, role, isOwner } = await fetchMe()
        const su = toSessionUser(user, role ?? null, isOwner)
        persist(su)
        set({ user: su })
      } catch { /* сеть/сервер лёг — работаем на прежних правах, а не выкидываем человека */ }
    },
    logout: () => {
      const uid = get().user?.id
      if (uid) void logoutUser(uid) // clock-out рабочего времени (§8.1)
      persist(null)
      try { localStorage.removeItem(opts.tokenKey) } catch { /* ignore */ } // токен ТОЛЬКО этой зоны
      if (opts.trackActivity) { try { localStorage.removeItem(ACTIVITY_KEY) } catch { /* ignore */ } }
      set({ user: null })
      // Жёсткая перезагрузка = чистая память приложения (MR-142 баг 1: без данных прошлой
      // сессии в кэшах). Уходим на вход СВОЕЙ зоны, чужую не трогаем.
      try { window.location.assign(opts.redirectTo) } catch { /* SSR/тест — пропускаем */ }
    },
  }))
}

/** Сессия ПАНЕЛИ. Ключи и поведение — как было; API стора неизменен для всех потребителей. */
export const useSession = createSessionStore({
  sessionKey: PANEL_SESSION_KEY, tokenKey: PANEL_TOKEN_KEY, redirectTo: '/', trackActivity: true,
})

/**
 * Сессия АДМИНКИ (созвон 19.08) — отдельная от панели. Тот же аккаунт может быть залогинен
 * в /admin и в /panel независимо; выход из одной зоны не трогает другую. Раньше вместо этого
 * был общий токен + «админ-гейт» поверх панельной сессии — из-за него «Выйти» из панели
 * выкидывал и из админки.
 */
export const useAdminSession = createSessionStore({
  sessionKey: ADMIN_SESSION_KEY, tokenKey: ADMIN_TOKEN_KEY, redirectTo: '/admin', trackActivity: false,
})
