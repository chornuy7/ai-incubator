import { create } from 'zustand'
import type {
  AppData, UserState, Locale, Theme, AccountStatus, BackgroundTask, LogLevel, Proxy,
} from '@/shared/types'
import { cloneSeed } from './seeds'
import { uid } from '@/shared/lib/utils'
import { fetchAccounts, fetchAccountBusy, patchAccount, emptyTrashApi } from '@/api/accountsApi'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'info'
  title: string
  desc?: string
}

const LS_KEY = 'ai-incubator:v2'

interface Persisted {
  userState: UserState
  locale: Locale
  theme: Theme
  netErrors: boolean
  data: AppData
}

interface AppStore extends Persisted {
  sidebarCollapsed: boolean
  mobileNavOpen: boolean
  toasts: Toast[]
  accountsLoading: boolean

  setUserState: (s: UserState) => void
  setLocale: (l: Locale) => void
  toggleTheme: () => void
  setTheme: (t: Theme) => void
  toggleNetErrors: () => void
  toggleSidebar: () => void
  setMobileNav: (open: boolean) => void
  resetData: () => void

  pushToast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  /** Возвращает true если действие "прошло"; при netErrors кидает toast-ошибку и возвращает false. */
  guardNet: (action?: string) => boolean

  loadAccounts: () => Promise<void>
  loadAccountBusy: () => Promise<void>
  trashAccount: (id: string) => Promise<void>
  restoreAccount: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  setAccountStatus: (id: string, status: AccountStatus) => Promise<void>
  setAccountProxy: (id: string, proxy: string) => Promise<void>

  addProxy: (p: Omit<Proxy, 'id' | 'usedBy' | 'status'>) => void
  removeProxy: (id: string) => void

  addTask: (t: Omit<BackgroundTask, 'id' | 'createdAt'> & { id?: string }) => void
  updateTask: (id: string, patch: Partial<BackgroundTask>) => void
  removeTask: (id: string) => void

  updateUser: (patch: Partial<AppData['user']>) => void
  toggleNotification: (id: string) => void
}

function parseInitialState(): UserState {
  const params = new URLSearchParams(window.location.search)
  const q = params.get('mockState')
  if (q === 'empty' || q === 'with-data' || q === 'no-sub' || q === 'guest') return q
  return 'with-data'
}

function dataFor(state: UserState): AppData {
  const base = state === 'guest' ? cloneSeed('empty') : cloneSeed(state)
  return { ...base, accounts: [] }
}

function loadPersisted(): Persisted | null {
  try {
    const forced = new URLSearchParams(window.location.search).get('mockState')
    if (forced) return null // явный сценарий из URL перекрывает сохранённое
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Persisted
  } catch {
    return null
  }
}

const boot = loadPersisted()
const initialState = boot?.userState ?? parseInitialState()

export const useApp = create<AppStore>((set, get) => {
  const persist = () => {
    const { userState, locale, theme, netErrors, data } = get()
    const { accounts: _a, ...restData } = data
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        userState, locale, theme, netErrors,
        data: { ...restData, accounts: [] },
      }))
    } catch {
      /* ignore quota */
    }
  }
  const mutate = (fn: (st: AppStore) => Partial<AppStore>) => {
    set(fn as never)
    persist()
  }

  return {
    userState: initialState,
    locale: boot?.locale ?? 'ru',
    theme: boot?.theme ?? 'dark',
    netErrors: boot?.netErrors ?? false,
    data: boot?.data ? { ...boot.data, accounts: [] } : dataFor(initialState),
    sidebarCollapsed: false,
    mobileNavOpen: false,
    toasts: [],
    accountsLoading: false,

    setUserState: (s) => {
      mutate(() => ({ userState: s, data: dataFor(s) }))
      void get().loadAccounts()
    },
    setLocale: (l) => mutate(() => ({ locale: l })),
    setTheme: (t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
      mutate(() => ({ theme: t }))
    },
    toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    toggleNetErrors: () => mutate((st) => ({ netErrors: !st.netErrors })),
    toggleSidebar: () => set((st) => ({ sidebarCollapsed: !st.sidebarCollapsed })),
    setMobileNav: (open) => set({ mobileNavOpen: open }),
    resetData: () => {
      mutate((st) => ({ data: dataFor(st.userState) }))
      void get().loadAccounts()
    },

    pushToast: (t) => {
      const id = uid('toast')
      set((st) => ({ toasts: [...st.toasts, { ...t, id }] }))
      setTimeout(() => get().dismissToast(id), 4200)
    },
    dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((x) => x.id !== id) })),

    guardNet: (action) => {
      if (get().netErrors) {
        get().pushToast({
          type: 'error',
          title: 'Ошибка сети',
          desc: action ? `Не удалось выполнить: ${action}. Повторите позже.` : 'Сервер недоступен. Повторите позже.',
        })
        return false
      }
      return true
    },

    loadAccounts: async () => {
      set({ accountsLoading: true })
      try {
        const accounts = await fetchAccounts()
        mutate((st) => ({ data: { ...st.data, accounts } }))
      } catch (e) {
        get().pushToast({
          type: 'error',
          title: 'Не удалось загрузить аккаунты',
          desc: e instanceof Error ? e.message : 'Проверьте, что API-сервер запущен',
        })
      } finally {
        set({ accountsLoading: false })
      }
    },

    loadAccountBusy: async () => {
      try {
        const busy = await fetchAccountBusy()
        mutate((st) => ({
          data: {
            ...st.data,
            accounts: st.data.accounts.map((a) => {
              const b = busy[a.id]
              if (b) return { ...a, busyIn: b }
              if (!a.busyIn) return a
              const { busyIn: _drop, ...rest } = a
              return rest
            }),
          },
        }))
      } catch { /* API offline */ }
    },

    trashAccount: async (id) => {
      if (!get().guardNet('перемещение в корзину')) return
      await patchAccount(id, { inTrash: true })
      await get().loadAccounts()
    },
    restoreAccount: async (id) => {
      if (!get().guardNet('восстановление')) return
      await patchAccount(id, { inTrash: false })
      await get().loadAccounts()
    },
    emptyTrash: async () => {
      if (!get().guardNet('очистка корзины')) return
      await emptyTrashApi()
      await get().loadAccounts()
    },
    setAccountStatus: async (id, status) => {
      await patchAccount(id, { status })
      await get().loadAccounts()
    },
    setAccountProxy: async (id, proxy) => {
      if (!get().guardNet('смена прокси')) return
      await patchAccount(id, { proxy })
      await get().loadAccounts()
    },

    addProxy: (p) =>
      mutate((st) => ({
        data: { ...st.data, proxies: [{ ...p, id: uid('px'), usedBy: 0, status: 'ok' }, ...st.data.proxies] },
      })),
    removeProxy: (id) =>
      mutate((st) => ({ data: { ...st.data, proxies: st.data.proxies.filter((x) => x.id !== id) } })),

    addTask: (t) =>
      mutate((st) => ({
        data: { ...st.data, tasks: [{ ...t, id: t.id ?? uid('task'), createdAt: Date.now() }, ...st.data.tasks] },
      })),
    updateTask: (id, patch) =>
      mutate((st) => ({
        data: { ...st.data, tasks: st.data.tasks.map((x) => (x.id === id ? { ...x, ...patch } : x)) },
      })),
    removeTask: (id) =>
      mutate((st) => ({ data: { ...st.data, tasks: st.data.tasks.filter((x) => x.id !== id) } })),

    updateUser: (patch) => mutate((st) => ({ data: { ...st.data, user: { ...st.data.user, ...patch } } })),
    toggleNotification: (id) =>
      mutate((st) => ({
        data: {
          ...st.data,
          notifications: st.data.notifications.map((n) => (n.id === id ? { ...n, enabled: !n.enabled } : n)),
        },
      })),
  }
})

// ── Селекторы-хелперы ──
export const activeAccounts = (d: AppData) => d.accounts.filter((a) => !a.inTrash)
export const trashedAccounts = (d: AppData) => d.accounts.filter((a) => a.inTrash)

export const STATUS_META: Record<AccountStatus, { label: string; text: string; bg: string; dot: string }> = {
  active: { label: 'Активные', text: 'text-spark-300', bg: 'bg-spark-500/12 border-spark-500/30', dot: 'bg-spark-400' },
  working: { label: 'В работе', text: 'text-iris-300', bg: 'bg-iris-500/12 border-iris-500/30', dot: 'bg-iris-400' },
  quarantine: { label: 'На карантине', text: 'text-amber-300', bg: 'bg-amber-500/12 border-amber-500/30', dot: 'bg-amber-400' },
  spamblock: { label: 'Спамблок', text: 'text-rose-300', bg: 'bg-rose-500/12 border-rose-500/30', dot: 'bg-rose-400' },
  invalid: { label: 'Невалидные', text: 'text-slate-300', bg: 'bg-slate-500/12 border-slate-500/30', dot: 'bg-slate-400' },
  frozen: { label: 'Замороженные', text: 'text-cyan-300', bg: 'bg-cyan-500/12 border-cyan-500/30', dot: 'bg-cyan-400' },
  reauth: { label: 'Реавторизация', text: 'text-violet-300', bg: 'bg-violet-500/12 border-violet-500/30', dot: 'bg-violet-400' },
}

export const LOG_LEVEL_META: Record<LogLevel, { label: string; color: string; dot: string }> = {
  info: { label: 'Info', color: 'text-sky-300', dot: 'bg-sky-400' },
  success: { label: 'Успех', color: 'text-spark-300', dot: 'bg-spark-400' },
  warning: { label: 'Предупр.', color: 'text-amber-300', dot: 'bg-amber-400' },
  error: { label: 'Ошибки', color: 'text-rose-300', dot: 'bg-rose-400' },
}
