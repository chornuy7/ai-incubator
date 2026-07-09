// Единый доменный слой мока. Позже mocks/ можно заменить на api/ без правок UI.

export type UserState = 'empty' | 'with-data' | 'no-sub' | 'guest'
export type Locale = 'ru' | 'en' | 'ua'
export type Theme = 'dark' | 'light'

export type AccountStatus =
  | 'active'
  | 'working'
  | 'quarantine'
  | 'spamblock'
  | 'invalid'
  | 'frozen'
  | 'reauth'

export interface TgAccount {
  id: string
  avatarColor: string
  name: string
  phone: string
  username: string
  role: string
  project: string
  country: string // код флага: ua/ru/kz/pl
  status: AccountStatus
  lastSeen: string // "отлёжка"
  proxy: string
  ggr?: number // GramGPT Рейтинг 0..100
  tgSessionId?: string // id сессии на TG API сервере
  createdAt: number
  inTrash?: boolean
  note?: string
  /** Аккаунт занят running-задачей другого (или этого) модуля */
  busyIn?: { moduleKey: string; taskId: string; moduleLabel: string }
}

export type TaskStatus = 'running' | 'paused' | 'done' | 'error' | 'queued'

export interface BackgroundTask {
  id: string
  module: string
  title: string
  status: TaskStatus
  progress: number
  accountsCount: number
  createdAt: number
  logCount: number
}

export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface LogEntry {
  id: string
  ts: string
  level: LogLevel
  account?: string
  message: string
}

export interface Plan {
  name: string
  accountLimit: number
}

export type TicketStatus = 'open' | 'progress' | 'waiting' | 'escalated' | 'closed'

export interface Ticket {
  id: string
  subject: string
  status: TicketStatus
  updatedAt: string
  messages: number
  preview: string
}

export interface ParsingHistoryItem {
  id: string
  date: string
  module: string
  status: 'done' | 'error' | 'running'
  keywords: string
  found: number
}

/** Категория ленты истории в статистике. */
export interface HistoryCategory {
  key: string
  label: string
  count: number
}

export interface StatSeriesPoint {
  label: string
  comments: number
  reactions: number
  messages: number
  views: number
}

export interface Stats {
  comments: number
  reactions: number
  messages: number
  views: number
  pm: number // ЛС-рассылка
  spamGroups: number
  series: StatSeriesPoint[]
  history: HistoryCategory[]
}

export interface Proxy {
  id: string
  type: 'socks5' | 'http'
  host: string
  port: number
  login?: string
  status: 'ok' | 'dead' | 'checking'
  usedBy: number
}

export interface Notification {
  id: string
  key: string
  label: string
  desc: string
  enabled: boolean
}

/** Строка результата парсинга (мок-превью). */
export interface ParseResult {
  id: string
  title: string
  username: string
  members: number
  kind: 'channel' | 'group' | 'user'
  verified?: boolean
  premium?: boolean
  lang: string
}

/** Реальная статистика аккаунта для модалки «Управление аккаунтом». */
export interface AccountStats {
  live: boolean
  busyIn: { moduleKey: string; taskId: string; moduleLabel: string } | null
  profile: {
    id: string | null
    firstName: string | null
    lastName: string | null
    username: string | null
    phone: string | null
    premium: boolean | null
    geo: string | null
    saved: boolean
  }
  proxy: {
    raw: string
    protocol: string | null
    ip: string | null
    port: number | null
    login: string | null
    configured: boolean
    working: boolean | null
    checkedAt: number | null
  }
  status: {
    valid: boolean
    sessionOk: boolean
    spamblock: 'clean' | 'blocked' | 'unknown'
    spamblockText: string | null
    warmingDays: number
    warmingActive: boolean
    accountStatus: string
  }
  dates: {
    addedAt: number | null
    lastCheckAt: number | null
    proxyCheckAt: number | null
  }
  health: {
    score: number
    label: string
    events: { ts: string; level: string; label: string; module: string }[]
  }
  longevity: {
    score: number
    risk: 'low' | 'medium' | 'high'
    factors: { key: string; label: string; positive: boolean }[]
  }
  activity: { ts: string; type: string; label: string; target?: string; level: string; module: string }[]
  role: string | null
  note: string
}

export interface AccountChannel {
  id: string
  title: string
  username: string
  members: number | null
  kind: 'channel' | 'group'
  unread: number
}

export interface AccountFolder {
  id: number | null
  title: string
  included: number
  pinned: number
}

export interface AppData {
  plan: Plan
  coins: number
  workspace: string
  user: { firstName: string; lastName: string; nick: string; email: string }
  accounts: TgAccount[]
  tasks: BackgroundTask[]
  tickets: Ticket[]
  parsingHistory: ParsingHistoryItem[]
  stats: Stats
  proxies: Proxy[]
  notifications: Notification[]
}
