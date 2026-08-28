import { create } from 'zustand'
import type { RolePermissions } from '@/api/rolesApi'
import { logoutUser, fetchMe, type User } from '@/api/usersApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { PANEL_SESSION_KEY, PANEL_TOKEN_KEY, ADMIN_SESSION_KEY, ADMIN_TOKEN_KEY } from './zone'

// MR-141: метка последней активности пользователя — для локального тайм-аута сессии по
// бездействию (без запросов в БД). Обновляется на реальных действиях (SessionGuard) и
// сбрасывается в «сейчас» при входе, чтобы свежая сессия не вылетела по старой метке.
export const ACTIVITY_KEY = 'ai-incubator:activity'
/**
 * Правка 20.08: у админки СВОЯ метка активности. Раньше метка была одна на обе зоны, а
 * сторож бездействия работал только в панели — админ-сессия не истекала вообще, и человек,
 * ушедший на несколько часов, возвращался в открытую админку.
 */
export const ADMIN_ACTIVITY_KEY = 'ai-incubator:admin-activity'
/** Ключ активности ТЕКУЩЕЙ зоны (панель/админка). */
export function activityKey(): string {
  try { return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') ? ADMIN_ACTIVITY_KEY : ACTIVITY_KEY } catch { return ACTIVITY_KEY }
}
export function markActivity(now = Date.now()) { try { localStorage.setItem(activityKey(), String(now)) } catch { /* ignore */ } }

/**
 * MR-203: настройки УСТРОЙСТВА, которые выход не трогает.
 *
 * Заказчик просил чистить всё, связанное с предыдущим человеком. Тема, язык и свёрнутые
 * группы меню к человеку не относятся — это настройка браузера, как громкость у плеера.
 * Сбрасывать их на выходе значит каждый раз возвращать светлую тему тому, кто выбрал
 * тёмную, и это не «безопасность», а раздражение.
 */
const DEVICE_PREFS = new Set(['ai-incubator:v3', 'ai-incubator:nav-collapsed'])

/** Ключи ЧУЖОЙ зоны: выход из панели не должен выкидывать из админки, и наоборот. */
const OTHER_ZONE_KEYS = (zone: 'panel' | 'admin') => (zone === 'panel'
  ? [ADMIN_SESSION_KEY, ADMIN_TOKEN_KEY, ADMIN_ACTIVITY_KEY]
  : [PANEL_SESSION_KEY, PANEL_TOKEN_KEY, ACTIVITY_KEY])

/**
 * MR-203: стереть следы уходящего человека из браузера.
 *
 * Что было. Выход снимал токен своей зоны и перезагружал страницу — память приложения
 * при этом чистилась, но всё, что переживает перезагрузку, оставалось: кэш состава
 * подписки, закрытые уведомления, аватар, черновики вкладки, куки. На созвоне 27.08 это
 * увидели живьём: на экране мелькнули 80 ⚡, и только через две секунды пришли настоящие
 * 200 ⚡. Заказчик: «система должна удалить все данные, весь кэш и все абсолютно данные,
 * связанные с предыдущим пользователем».
 *
 * Что делаем. Убираем ключи уходящего человека (они именные — оканчиваются на его id),
 * ключи его зоны, всё содержимое sessionStorage (это черновики вкладки: какая задача
 * открыта, показывали ли поп-ап баланса) и куки. Настройки устройства и ключи ЧУЖОЙ
 * зоны не трогаем.
 *
 * @param userId кто уходит; без него именные ключи не вычислить — чистим только общее
 * @param zone из какой зоны выходят
 */
export function clearUserTraces(userId: string | undefined, zone: 'panel' | 'admin') {
  if (typeof window === 'undefined') return
  const keep = new Set([...DEVICE_PREFS, ...OTHER_ZONE_KEYS(zone)])
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('ai-incubator:') || keep.has(key)) continue
      // Именные ключи (`…:<id>`) чистим только у того, кто уходит: на общем компьютере у
      // второго человека могут лежать свои, и стирать их мы не вправе.
      const named = /:(usr_[A-Za-z0-9_-]+|anon)$/.exec(key)
      if (named && userId && named[1] !== userId && named[1] !== 'anon') continue
      localStorage.removeItem(key)
    }
  } catch { /* приватный режим или запрет на хранилище — выходу это мешать не должно */ }

  // sessionStorage живёт только в этой вкладке и целиком относится к текущему сеансу:
  // черновики, «уже видел поп-ап», какая задача открыта. Уходит человек — уходит всё.
  try { sessionStorage.clear() } catch { /* ignore */ }

  // Куки перезагрузка не трогает. Своей авторизации на куках у нас нет (токен в
  // localStorage), поэтому чистим всё, что видно этому origin.
  try {
    for (const pair of document.cookie.split(';')) {
      const name = pair.split('=')[0]?.trim()
      if (!name) continue
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
    }
  } catch { /* ignore */ }
}

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
function createSessionStore(opts: { sessionKey: string; tokenKey: string; redirectTo: string; trackActivity: boolean; activityKey?: string }) {
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
      // MR-141: свежая сессия → отсчёт бездействия с нуля (ключ — своей зоны).
      if (opts.trackActivity) { try { localStorage.setItem(opts.activityKey || ACTIVITY_KEY, String(Date.now())) } catch { /* ignore */ } }
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
      if (opts.trackActivity) { try { localStorage.removeItem(opts.activityKey || ACTIVITY_KEY) } catch { /* ignore */ } }
      // MR-203: снять токен мало — за человеком остаются кэш подписки, закрытые
      // уведомления, аватар, черновики вкладки и куки. Перезагрузка ниже их не трогает.
      clearUserTraces(uid, opts.tokenKey === ADMIN_TOKEN_KEY ? 'admin' : 'panel')
      set({ user: null })
      // Жёсткая перезагрузка = чистая память приложения (MR-142 баг 1: без данных прошлой
      // сессии в кэшах). Уходим на вход СВОЕЙ зоны, чужую не трогаем.
      try { window.location.assign(opts.redirectTo) } catch { /* SSR/тест — пропускаем */ }
    },
  }))
}

/** Сессия ПАНЕЛИ. Ключи и поведение — как было; API стора неизменен для всех потребителей. */
export const useSession = createSessionStore({
  sessionKey: PANEL_SESSION_KEY, tokenKey: PANEL_TOKEN_KEY, redirectTo: '/', trackActivity: true, activityKey: ACTIVITY_KEY,
})

/**
 * Сессия АДМИНКИ (созвон 19.08) — отдельная от панели. Тот же аккаунт может быть залогинен
 * в /admin и в /panel независимо; выход из одной зоны не трогает другую. Раньше вместо этого
 * был общий токен + «админ-гейт» поверх панельной сессии — из-за него «Выйти» из панели
 * выкидывал и из админки.
 */
export const useAdminSession = createSessionStore({
  // Правка 20.08: админка тоже ведёт метку бездействия — со своим ключом, чтобы активность
  // в панели не держала админ-сессию живой (и наоборот). Раньше trackActivity был false, и
  // админ-сессия не истекала вообще.
  sessionKey: ADMIN_SESSION_KEY, tokenKey: ADMIN_TOKEN_KEY, redirectTo: '/admin', trackActivity: true, activityKey: ADMIN_ACTIVITY_KEY,
})
