import { apiGet, apiPost } from './client'

// §8 (MR-44): тикеты поддержки с сервера — переписка живёт на бэкенде, видна в админке.
export type TicketStatus = 'open' | 'progress' | 'waiting' | 'escalated' | 'closed'

export interface TicketMessage {
  id: string
  from: 'user' | 'support'
  authorId: string
  /** Имя автора на момент отправки: имя клиента или «Поддержка». */
  authorName?: string
  /** Почта автора — основная подпись в чате (имя в базе бывает ролевым). */
  authorEmail?: string
  text: string
  ts: number
}
export interface ApiTicket {
  id: string
  userId: string
  subject: string
  category: string
  status: TicketStatus
  createdAt: number
  updatedAt: number
  messages: TicketMessage[]
  /** Кто владелец (для стороны поддержки): имя/мейл клиента. */
  ownerName?: string
  ownerEmail?: string
  /** Сколько непрочитанных для стороны запроса (клиент видит от поддержки и наоборот). */
  unread?: number
  /**
   * MR-257: кому адресовано. Пусто — нам, платформенной поддержке. Заполнено — владельцу
   * пространства (сотрудник просит токены, аккаунт, снятое ограничение).
   *
   * Поддержке это видно отдельной меткой: мы читаем ВСЕ обращения, но отвечать на чужой
   * запрос вместо владельца — значит влезть в чужие отношения и, скорее всего, пообещать
   * то, чего не можем дать.
   */
  toOwnerId?: string | null
}

/** asSupport=true — сторона поддержки (все тикеты, ответ как «Поддержка»). */
const scope = (asSupport?: boolean) => (asSupport ? '?scope=all' : '')
const asParam = (asSupport?: boolean) => (asSupport ? '?as=support' : '')

export async function fetchTickets(asSupport?: boolean): Promise<ApiTicket[]> {
  return (await apiGet<{ ok: boolean; tickets: ApiTicket[] }>(`/api/tickets${scope(asSupport)}`)).tickets || []
}

export async function fetchTicket(id: string, asSupport?: boolean): Promise<ApiTicket> {
  return (await apiGet<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}${asParam(asSupport)}`)).ticket
}

/** `toSupport` — сотрудник пишет платформе, а не своему владельцу (по умолчанию владельцу). */
export async function createTicket(input: { subject: string; category?: string; body?: string; toSupport?: boolean }): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>('/api/tickets', input)).ticket
}

export async function replyTicket(id: string, text: string, asSupport?: boolean): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}/reply`, { text, asSupport: !!asSupport })).ticket
}

export async function markTicketRead(id: string, asSupport?: boolean): Promise<void> {
  await apiPost(`/api/tickets/${id}/read`, { asSupport: !!asSupport })
}

/** Суммарно непрочитанных для стороны — для значка в навигации. */
export async function fetchTicketsUnread(asSupport?: boolean): Promise<number> {
  try { return (await apiGet<{ ok: boolean; count: number }>(`/api/tickets/unread-count${asParam(asSupport)}`)).count || 0 }
  catch { return 0 }
}

/** Только для поддержки/админа. */
export async function setTicketStatus(id: string, status: TicketStatus): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}/status`, { status })).ticket
}
