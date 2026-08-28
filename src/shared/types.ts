// Единый доменный слой мока. Позже mocks/ можно заменить на api/ без правок UI.

export type UserState = 'empty' | 'with-data' | 'no-sub' | 'guest'
export type Locale = 'ru' | 'en' | 'ua'
export type Theme = 'dark' | 'light'

export type AccountStatus =
  | 'active'
  | 'working'
  | 'warming'
  | 'pause'
  | 'floodwait'
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
  /** §6.3 (AM-002): прокси рабочий (нет прокси или не 'dead'). false — мёртвый прокси, аккаунт не предлагаем для запуска. */
  proxyOk?: boolean
  /** MR-131: у аккаунта вообще нет прокси (прямое подключение) — тоже зона риска, отдельно от мёртвого прокси. */
  noProxy?: boolean
  /** MR-131: «зона риска» с конкретикой. Две независимые оси: прокси и статус/здоровье. */
  risk?: {
    level: 'none' | 'low' | 'medium' | 'high'
    factors: { kind: 'proxy' | 'status' | 'trust'; text: string }[]
    proxyIssue: boolean
    statusIssue: boolean
  }
  ggr?: number // GramGPT Рейтинг 0..100
  trustScore?: number // §3.3 кэш trust score 0..100
  trustBand?: 'low' | 'mid' | 'high'
  tgSessionId?: string // id сессии на TG API сервере
  createdAt: number
  inTrash?: boolean
  note?: string
  /** Аккаунт выделен под ревизию базы парсера (крон раз в 12 часов). Метка ставится в админке. */
  service?: boolean
  /**
   * Аккаунт ПЛАТФОРМЫ, а не клиента: заведён импортом с отметкой «для платформы».
   * Только такие могут дежурить по ревизии базы (правка 27.08).
   */
  platform?: boolean
  /** До какого времени держится временный статус (спамблок/флудвейт/карантин). */
  statusUntil?: number | null
  /** Почему статус выставлен — показывается подсказкой в менеджере. */
  statusReason?: string
  /** MR: когда аккаунт последний раз явно проверяли на живость (?verify). null — ни разу. */
  lastCheckedAt?: number | null
  /** MR: результат последней явной проверки — true жив, false не ответил, null не проверяли. */
  lastCheckOk?: boolean | null
  /** Аккаунт занят задачей другого (или этого) модуля. taskStatus — running/paused/… */
  busyIn?: {
    moduleKey: string; taskId: string; moduleLabel: string; taskStatus?: string
    /** Многомодульность (20.08): все модули, где аккаунт занят (busyIn — первый из них). */
    modules?: { moduleKey: string; moduleLabel: string }[]
  }
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
  // Поля Фазы 0 (§3.1): контекст события задачи.
  module?: string
  initiator?: string
  code?: string
  reason?: string
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
  /**
   * Пауза при переходе аккаунта между модулями: из какого модуля вышел, сколько
   * назначено и сколько осталось. `null` — паузы сейчас нет.
   */
  switchPause: { fromModule: string; fromLabel: string; coolMs: number; until: number; leftMs: number; text: string } | null
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
    /** none — прокси не назначен, down — не отвечает, ok — рабочий, unknown — не проверялся. */
    state?: 'none' | 'down' | 'ok' | 'unknown'
    /** Человеческая причина вместо «неизвестной ошибки». */
    problem?: string | null
  }
  status: {
    valid: boolean
    /** Данные из базы — живой проверки сейчас не делали (кнопка «Проверить» её запускает). */
    fromCache?: boolean
    /** Когда проверяли по-настоящему в последний раз. */
    lastValidAt?: number | null
    /** Проверку не довели до конца: причина в прокси, а не в аккаунте. */
    checkBlocked?: 'no_proxy' | 'proxy_down' | null
    checkNote?: string | null
    sessionOk: boolean
    spamblock: 'clean' | 'blocked' | 'unknown'
    spamblockText: string | null
    spamblockAt: number | null // MR-63: когда спамблок проверяли в последний раз
    warmingDays: number
    warmingActive: boolean
    accountStatus: string
  }
  dates: {
    addedAt: number | null
    lastCheckAt: number | null
    proxyCheckAt: number | null
    spamblockAt: number | null // MR-63
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
  trust: {
    score: number
    band: 'low' | 'mid' | 'high'
    action: 'autostop' | 'conservative' | 'pool'
    label: string
    hint: string
    parts: { flood: number; bans: number; actions: number; age: number }
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
