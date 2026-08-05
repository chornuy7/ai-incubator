/**
 * §8 (MR-44): тикеты поддержки — СВОЁ хранилище на сервере, чтобы обращения жили не
 * в браузере (мок), а были видны в админ-панели: клиент создаёт тикет и переписывается,
 * поддержка/админ видит все обращения, отвечает и двигает статус. Файловый JSON-стор,
 * как остальные (goals/leads) — через lib/jsonStore.
 *
 * Модель тикета:
 *   { id, userId, subject, category, status, createdAt, updatedAt,
 *     messages: [{ id, from:'user'|'support', authorId, text, ts }] }
 */
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const ticketsFile = () => process.env.TICKETS_FILE || dataPath('tickets.json')

export const TICKET_STATUSES = ['open', 'progress', 'waiting', 'escalated', 'closed']
const STATUS_SET = new Set(TICKET_STATUSES)

/** Короткий, но уникальный в пределах стора id (по времени создания). */
function genId(now, existing) {
  let id = `TK-${String(now).slice(-6)}`
  let n = 1
  while (existing.some((t) => t.id === id)) id = `TK-${String(now).slice(-6)}-${n++}`
  return id
}

const msg = (from, authorId, text, ts) => ({
  id: `m${ts}${Math.floor(ts % 1000)}`,
  from: from === 'support' ? 'support' : 'user',
  authorId: authorId || '—',
  text: String(text).trim(),
  ts,
})

export async function listTickets({ userId = '', all = false } = {}) {
  const tickets = await readJson(ticketsFile(), [])
  const rows = all ? tickets : tickets.filter((t) => t.userId === userId)
  return rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getTicket(id) {
  const tickets = await readJson(ticketsFile(), [])
  return tickets.find((t) => t.id === id) || null
}

export async function createTicket({ userId = '', subject = '', category = 'tech', body = '' }) {
  const subj = String(subject || '').trim()
  if (!subj) throw new Error('Укажите тему обращения')
  const tickets = await readJson(ticketsFile(), [])
  const now = Date.now()
  const ticket = {
    id: genId(now, tickets),
    userId: userId || '—',
    subject: subj,
    category: String(category || 'tech'),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  const text = String(body || '').trim()
  if (text) ticket.messages.push(msg('user', userId, text, now))
  tickets.push(ticket)
  await writeJson(ticketsFile(), tickets)
  return ticket
}

/**
 * Добавить сообщение в тикет. Ответ поддержки переводит открытый/ожидающий тикет
 * в «в работе»; ответ клиента по закрытому — снова открывает (переписка продолжилась).
 */
export async function addMessage(id, { from = 'user', authorId = '', text = '' }) {
  const t = String(text || '').trim()
  if (!t) throw new Error('Пустое сообщение')
  const tickets = await readJson(ticketsFile(), [])
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  const now = Date.now()
  ticket.messages.push(msg(from, authorId, t, now))
  ticket.updatedAt = now
  if (from === 'support') { if (ticket.status === 'open' || ticket.status === 'waiting') ticket.status = 'progress' }
  else if (ticket.status === 'closed') ticket.status = 'open'
  await writeJson(ticketsFile(), tickets)
  return ticket
}

export async function setStatus(id, status) {
  if (!STATUS_SET.has(status)) throw new Error('Неизвестный статус')
  const tickets = await readJson(ticketsFile(), [])
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  ticket.status = status
  ticket.updatedAt = Date.now()
  await writeJson(ticketsFile(), tickets)
  return ticket
}
