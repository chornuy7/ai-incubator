import type { TgAccount, AccountStatus, AccountStats, AccountChannel, AccountFolder } from '@/shared/types'
import { apiGet, apiPost, apiPatch, apiDelete } from './client'

export type ServerAccount = TgAccount

// ВАЖНО (bugfix): все запросы аккаунтов идут через apiGet/apiPost/apiPatch/apiDelete —
// они ставят заголовки авторизации (X-User-Id + Bearer). Голый fetch их НЕ ставил, и при
// включённой авторизации (есть SESSION_SECRET) сервер отвечал 401 «Требуется вход» —
// менеджер аккаунтов не загружался. Баланс/настройки работали, т.к. уже шли через клиент.

/** Карточка аккаунта, как её отдаёт сервер. Всё время — ISO-строками. */
export interface ApiAccount {
  id: string
  ownerId: string | null
  createdAt: string | null
  updatedAt: string | null
  inTrash: boolean
  role: string
  note: string
  kind: { service: boolean; platform: boolean }
  profile: { name: string; username: string; phone: string; telegramUserId: string | null; country: string; avatarColor: string }
  status: { value: string; code: string | null; params: Record<string, unknown>; since: string | null; until: string | null; previous: string | null }
  security: { twoFactor: boolean }
  session: { present: boolean; checkedAt: string | null; ok: boolean | null; healthCheckedAt: string | null }
  proxy: null | { id: string; label: string; scheme: string | null; host: string | null; port: number | null; country: string | null; status: string; checkedAt: string | null; ok: boolean }
  trust: null | { score: number; band: string | null }
  risk?: TgAccount['risk']
  limit?: TgAccount['limit']
  appeal?: null | { state: string; at: string | null }
  geo?: TgAccount['geo']
  busy: null | { taskId: string; modules: { key: string; label: string }[] }
  origin: { code: string | null; params: Record<string, unknown> }
}

export interface AccountsFacets {
  /** Сколько аккаунтов в каждой стране — чтобы в фильтре были страны ПАРКА, а не страницы. */
  countries: Record<string, number>
  risk: { deadProxy: number; noProxy: number; lowTrust: number }
  modules: Record<string, { label: string; count: number }>
  busyTotal: number
}

export interface AccountsPage {
  items: ServerAccount[]
  page: { number: number; size: number; total: number; pages: number }
  /** Плитки над таблицей: по всему парку, а не по показанной странице. */
  counts: Record<string, number>
  facets: AccountsFacets
}

/**
 * Запрос страницы.
 *
 * Все фильтры уходят НА СЕРВЕР. Отбирать после выборки страницы нельзя: из двадцати пяти
 * строк осталось бы семь, а «всего» посчиталось бы по нефильтрованному набору.
 */
export interface AccountsQuery {
  page?: number
  pageSize?: number
  search?: string
  statuses?: string[]
  /** Коды стран. Регион («Европа») раскрывает клиент — карта регионов живёт у него. */
  countries?: string[]
  risk?: 'deadProxy' | 'noProxy' | 'lowTrust'
  campaignId?: string
  /** Ключ модуля либо 'idle' — свободные. */
  busyModule?: string
  fatigueMin?: number
  inTrash?: boolean
  /** В корзине показывать только живые (без невалидных и требующих входа). */
  trashAlive?: boolean
  sort?: { field: string; dir: 'asc' | 'desc' }
}

/** Ответ сервера → внутренняя модель панели. Единственное место перевода. */
export function toTgAccount(a: ApiAccount): ServerAccount {
  return {
    id: a.id,
    avatarColor: a.profile.avatarColor,
    name: a.profile.name,
    phone: a.profile.phone || '—',
    username: a.profile.username,
    role: a.role,
    country: a.profile.country,
    status: a.status.value as TgAccount['status'],
    // Момент времени, а не «11 ч». Формулировку строит интерфейс — там, где её и видно.
    lastSeenAt: a.updatedAt ?? a.createdAt,
    proxyId: a.proxy?.id ?? null,
    // Подпись для таблицы. Строки подключения с логином и паролем в браузере больше нет.
    proxyLabel: a.proxy ? (a.proxy.label || [a.proxy.host, a.proxy.port].filter(Boolean).join(':')) : '',
    proxyOk: a.proxy ? a.proxy.ok : true,
    noProxy: !a.proxy,
    risk: a.risk,
    limit: a.limit,
    appeal: a.appeal ? { state: a.appeal.state as NonNullable<TgAccount['appeal']>['state'], at: a.appeal.at ? Date.parse(a.appeal.at) : null } : null,
    geo: a.geo ?? null,
    trustScore: a.trust?.score,
    trustBand: a.trust?.band as TgAccount['trustBand'],
    createdAt: a.createdAt ? Date.parse(a.createdAt) : 0,
    inTrash: a.inTrash,
    note: a.note,
    originCode: a.origin.code,
    service: a.kind.service,
    platform: a.kind.platform,
    statusUntil: a.status.until ? Date.parse(a.status.until) : null,
    statusCode: a.status.code,
    statusParams: a.status.params,
    lastCheckedAt: a.session.checkedAt ? Date.parse(a.session.checkedAt) : null,
    lastCheckOk: a.session.ok,
    has2fa: a.security.twoFactor,
    hasSession: a.session.present,
    busyIn: a.busy
      ? { moduleKey: a.busy.modules[0]?.key ?? '', taskId: a.busy.taskId, moduleLabel: a.busy.modules[0]?.label ?? '', modules: a.busy.modules.map((m) => ({ moduleKey: m.key, moduleLabel: m.label })) }
      : undefined,
  }
}

/**
 * Страница списка аккаунтов.
 *
 * POST, а не GET: у запроса фильтры, поиск, сортировка и постраничность — это тело, а не
 * строка адреса. Заодно поисковый запрос оператора (а это вполне может быть номер
 * телефона) перестаёт оседать в истории браузера и в логах прокси.
 */
/** Разбор «не в строю» по причинам: сколько и кто именно (имён немного — это ответ, а не список). */
export interface BrokenGroup { reason: string; link: string; total: number; items: { id: string; name: string }[] }

/**
 * Числа для шапки панели БЕЗ списка аккаунтов.
 *
 * Шапка показывает «в строю N из M» на каждой странице. Раньше ради двух чисел грузился
 * весь парк — в том числе на «Прокси» и «Статистике», где аккаунтов нет и близко.
 */
export async function fetchAccountsSummary(): Promise<{ counts: Record<string, number>; facets: AccountsFacets }> {
  const d = await apiGet<{ counts?: Record<string, number>; facets?: AccountsFacets }>('/api/tg/accounts/summary')
  return {
    counts: d.counts && typeof d.counts === 'object' ? d.counts : {},
    // Грани сливаем с пустыми: недостающая ветка ответа не должна ронять шапку.
    facets: { ...ПУСТЫЕ_ГРАНИ, ...(d.facets || {}), risk: { ...ПУСТЫЕ_ГРАНИ.risk, ...(d.facets?.risk || {}) } },
  }
}

/** Кто «не в строю» — запрашивается по клику, а не постоянно. */
export async function fetchBrokenAccounts(limit = 8): Promise<BrokenGroup[]> {
  const d = await apiGet<{ groups?: BrokenGroup[] }>(`/api/tg/accounts/broken?limit=${limit}`)
  // Приводим к ожидаемой форме здесь, в одном месте: дальше по коду данные считаются целыми.
  return (Array.isArray(d.groups) ? d.groups : []).map((g) => ({
    reason: String(g?.reason || ''),
    link: String(g?.link || ''),
    total: Number(g?.total) || 0,
    items: Array.isArray(g?.items) ? g.items : [],
  }))
}

const ПУСТЫЕ_ГРАНИ: AccountsFacets = { countries: {}, risk: { deadProxy: 0, noProxy: 0, lowTrust: 0 }, modules: {}, busyTotal: 0 }

export async function fetchAccountsPage(query: AccountsQuery = {}): Promise<AccountsPage> {
  const data = await apiPost<{ items: ApiAccount[]; page: AccountsPage['page']; counts: Record<string, number>; facets?: AccountsFacets }>(
    '/api/tg/accounts/list', query as unknown as Record<string, unknown>,
  )
  return {
    items: (data.items ?? []).map(toTgAccount),
    page: data.page,
    counts: data.counts ?? {},
    facets: { ...ПУСТЫЕ_ГРАНИ, ...(data.facets || {}) },
  }
}

/**
 * Весь парк — страницами под капотом.
 *
 * ЭТО НЕ ДЛЯ МЕНЕДЖЕРА АККАУНТОВ. Он ходит `fetchAccountsPage` и просит ровно ту страницу,
 * которую показывает. Полный обход нужен экранам, где список используется как справочник
 * целиком: выбор аккаунтов при запуске модуля, привязка лида, рельса диалогов.
 *
 * Размер пачки (200) — это НЕ размер страницы в интерфейсе, а шаг обхода: чем он больше,
 * тем меньше запросов на полный список. Путать их не надо: в менеджере размер страницы
 * задаёт оператор селектором «25 / стр».
 */
const ШАГ_ПОЛНОГО_ОБХОДА = 200

export async function fetchAccounts(): Promise<ServerAccount[]> {
  const out: ServerAccount[] = []
  let page = 1
  for (;;) {
    const p = await fetchAccountsPage({ page, pageSize: ШАГ_ПОЛНОГО_ОБХОДА })
    out.push(...p.items)
    if (page >= p.page.pages || !p.items.length) break
    page += 1
  }
  return out
}

export type AccountBusyMap = Record<string, { moduleKey: string; taskId: string; moduleLabel: string; taskStatus?: string }>

export async function fetchAccountBusy(): Promise<AccountBusyMap> {
  const data = await apiGet<{ busy?: AccountBusyMap }>('/api/tg/accounts/busy')
  return data.busy ?? {}
}

export async function patchAccount(
  accountId: string,
  patch: Partial<Pick<TgAccount, 'role' | 'country' | 'status' | 'inTrash' | 'note'>>
    & { initiator?: string; service?: boolean; proxyId?: string | null },
) {
  return apiPatch<{ ok: boolean }>(`/api/tg/accounts/${accountId}`, patch)
}

export async function deleteAccount(accountId: string) {
  return apiDelete<{ ok: boolean }>(`/api/tg/accounts/${accountId}`)
}

export async function emptyTrashApi() {
  return apiPost<{ ok: boolean; count: number }>('/api/tg/accounts/empty-trash')
}

export async function patchAccountStatus(accountId: string, status: AccountStatus) {
  return patchAccount(accountId, { status })
}

/**
 * Статистика аккаунта. По умолчанию — СОХРАНЁННЫЙ вердикт (мгновенно, без сети).
 * `force` — живая перепроверка по кнопке «Проверить».
 */
export async function fetchAccountStats(accountId: string, opts?: { spam?: boolean; force?: boolean }): Promise<AccountStats> {
  const qs = opts?.spam ? '?spam=1' : opts?.force ? '?force=1' : ''
  const data = await apiGet<{ stats: AccountStats }>(`/api/tg/accounts/${accountId}/stats${qs}`)
  return data.stats
}

export async function fetchAccountChannels(accountId: string): Promise<{ busy: boolean; channels: AccountChannel[]; error?: string; busyIn?: { moduleLabel: string } }> {
  return apiGet(`/api/tg/accounts/${accountId}/channels`)
}

/** MR-164: одно сообщение канала/группы для просмотра переписки из карточки. */
export interface ChannelMessage { id: number; text: string; date: number; out: boolean; hasMedia: boolean; sender: string }

/** MR-164: последние сообщения канала/группы аккаунта (живой Telegram-запрос через сессию). */
export async function fetchAccountChannelMessages(accountId: string, peer: string): Promise<{ busy?: boolean; title?: string; messages: ChannelMessage[]; error?: string }> {
  return apiGet(`/api/tg/accounts/${accountId}/channel-messages?peer=${encodeURIComponent(peer)}`)
}

/** MR-129: аккаунт выходит из канала/группы (по id из списка каналов). */
export async function leaveAccountChannel(accountId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost<{ ok: boolean; error?: string }>(`/api/tg/accounts/${accountId}/channels/${channelId}/leave`, {})
}

export type DailyActionItem = { action: 'comments' | 'dm' | 'joins' | 'reactions'; used: number; cap: number; reached: boolean }
export type AccountDaily = { accountId: string; date: string; items: DailyActionItem[] }

/** Суточные счётчики действий аккаунта против потолков (§6) — для вкладки «Здоровье». */
export async function fetchAccountDaily(accountId: string): Promise<AccountDaily> {
  const data = await apiGet<{ daily: AccountDaily }>(`/api/tg/accounts/${accountId}/daily`)
  return data.daily
}

export type DailyAllEntry = { items: DailyActionItem[]; anyReached: boolean }
export type DailyAllMap = Record<string, DailyAllEntry>

/** Сводка §6 по всем активным сегодня аккаунтам — для индикатора throttle в списке. */
export async function fetchDailyAll(): Promise<DailyAllMap> {
  const data = await apiGet<{ daily?: DailyAllMap }>('/api/tg/accounts/daily-all')
  return data.daily ?? {}
}

export async function fetchAccountFolders(accountId: string): Promise<{ busy: boolean; folders: AccountFolder[]; error?: string; busyIn?: { moduleLabel: string } }> {
  return apiGet(`/api/tg/accounts/${accountId}/folders`)
}

export async function releaseAccountLock(accountId: string): Promise<{ ok: boolean; released: { taskId: string; moduleLabel: string } | null }> {
  return apiPost(`/api/tg/accounts/${accountId}/release`)
}

/** Ручная смена статуса оператором (пауза/снятие) через state machine + аудит. */
export async function setAccountStatusManual(accountId: string, to: 'pause' | 'active', initiator?: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost(`/api/tg/accounts/${accountId}/status`, { to, initiator })
}

export async function reconcileLocks(): Promise<{ ok: boolean; dropped: { accountId: string; taskId: string; moduleKey: string }[] }> {
  return apiPost('/api/modules/locks/reconcile')
}

/**
 * Что аккаунт нам принёс: задачи, действия, токены, деньги, лиды — по модулям.
 * Отдельно от профиля Telegram: тот отвечает «кто он», этот — «какая отдача».
 */
export interface AccountWorkModule { moduleKey: string; title: string; tasks: number; actions: number; tokens: number; spent: number }
export interface AccountWork {
  accountId: string
  tasks: number
  actions: number
  spent: number
  tokens: number
  tokenCoins: number
  totalCoins: number
  errors: number
  lastUsed: number
  leads: { total: number; active: number; target: number }
  byModule: AccountWorkModule[]
  recent: { id: string; moduleKey: string; title: string; status: string; at: number; actions: number }[]
}

export async function fetchAccountWork(accountId: string, since?: number): Promise<AccountWork> {
  const q = since ? `?since=${since}` : ''
  const r = await apiGet<{ ok: boolean; work: AccountWork }>(`/api/accounts/${accountId}/work${q}`)
  return r.work
}

/** LOG-002/003: одно действие аккаунта из журнала (docs/CONTRACT-action-log). */
export type AccountActionType = 'post' | 'comment' | 'reaction' | 'chat' | 'dialog' | 'dm' | 'join' | 'action'
export interface AccountAction {
  id: string
  ts: string
  type: AccountActionType
  status: string
  accountId: string
  accountName: string
  target: string
  targetTitle: string
  objectRef: { postId?: number; url?: string; replyToId?: number | null }
  value: { text?: string; emoji?: string; kind?: string }
  moduleKey: string
  taskId: string
  launchId: string
  goalId: string
  audience: { repliesCount?: number; reactionsCount?: number; reactions?: Record<string, number>; replies?: unknown[] }
}

/** История действий аккаунта (MR-122). Фильтры: тип, группа/канал, период. */
export async function fetchAccountActions(
  accountId: string,
  filter?: { type?: string; target?: string; since?: number; until?: number; limit?: number },
): Promise<AccountAction[]> {
  const p = new URLSearchParams()
  if (filter?.type) p.set('type', filter.type)
  if (filter?.target) p.set('target', filter.target)
  if (filter?.since) p.set('since', String(filter.since))
  if (filter?.until) p.set('until', String(filter.until))
  if (filter?.limit) p.set('limit', String(filter.limit))
  const qs = p.toString() ? `?${p.toString()}` : ''
  const r = await apiGet<{ ok: boolean; actions: AccountAction[] }>(`/api/accounts/${accountId}/actions${qs}`)
  return r.actions || []
}
