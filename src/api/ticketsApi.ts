import { apiGet, apiPost } from './client'

// §8 (MR-44): тикеты поддержки с сервера — переписка живёт на бэкенде, видна в админке.
export type TicketStatus = 'open' | 'progress' | 'waiting' | 'escalated' | 'closed'

export interface TicketMessage {
  id: string
  from: 'user' | 'support'
  authorId: string
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
}

export async function fetchTickets(): Promise<ApiTicket[]> {
  return (await apiGet<{ ok: boolean; tickets: ApiTicket[] }>('/api/tickets')).tickets || []
}

export async function fetchTicket(id: string): Promise<ApiTicket> {
  return (await apiGet<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}`)).ticket
}

export async function createTicket(input: { subject: string; category?: string; body?: string }): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>('/api/tickets', input)).ticket
}

export async function replyTicket(id: string, text: string): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}/reply`, { text })).ticket
}

/** Только для поддержки/админа. */
export async function setTicketStatus(id: string, status: TicketStatus): Promise<ApiTicket> {
  return (await apiPost<{ ok: boolean; ticket: ApiTicket }>(`/api/tickets/${id}/status`, { status })).ticket
}
