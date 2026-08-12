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

const msg = (from, authorId, authorName, text, ts) => ({
  id: `m${ts}${Math.floor(ts % 1000)}`,
  from: from === 'support' ? 'support' : 'user',
  authorId: authorId || '—',
  // Denормализуем ИМЯ автора в момент отправки — чтобы в чате было видно, КТО написал
  // (мейл/имя клиента), а не роль. Для поддержки — «Поддержка».
  authorName: String(authorName || (from === 'support' ? 'Поддержка' : 'Клиент')).trim(),
  text: String(text).trim(),
  ts,
})

/**
 * Сколько НЕПРОЧИТАННЫХ сообщений для стороны `side` ('support' видит непрочитанные от
 * клиента; владелец 'user' — непрочитанные от поддержки). reads[side] — метка «прочитано до».
 * @param {object} ticket @param {'support'|'user'} side
 */
export function unreadFor(ticket, side) {
  const seen = (ticket.reads || {})[side] || 0
  const fromOther = side === 'support' ? 'user' : 'support'
  return (ticket.messages || []).filter((m) => m.from === fromOther && (m.ts || 0) > seen).length
}

export async function listTickets({ userId = '', all = false } = {}) {
  const tickets = await readJson(ticketsFile(), [])
  const rows = all ? tickets : tickets.filter((t) => t.userId === userId)
  return rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getTicket(id) {
  const tickets = await readJson(ticketsFile(), [])
  return tickets.find((t) => t.id === id) || null
}

export async function createTicket({ userId = '', authorName = '', subject = '', category = 'tech', body = '' }) {
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
    // Метки «прочитано до» по сторонам. Владелец только что создал — своё считаем прочитанным.
    reads: { user: now, support: 0 },
  }
  const text = String(body || '').trim()
  if (text) ticket.messages.push(msg('user', userId, authorName, text, now))
  tickets.push(ticket)
  await writeJson(ticketsFile(), tickets)
  return ticket
}

/** Отметить тикет прочитанным для стороны (обнуляет её счётчик непрочитанного). */
export async function markRead(id, side) {
  const tickets = await readJson(ticketsFile(), [])
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) return null
  ticket.reads = ticket.reads || {}
  ticket.reads[side === 'support' ? 'support' : 'user'] = Date.now()
  await writeJson(ticketsFile(), tickets)
  return ticket
}

/**
 * Добавить сообщение в тикет. Ответ поддержки переводит открытый/ожидающий тикет
 * в «в работе»; ответ клиента по закрытому — снова открывает (переписка продолжилась).
 */
export async function addMessage(id, { from = 'user', authorId = '', authorName = '', text = '' }) {
  const t = String(text || '').trim()
  if (!t) throw new Error('Пустое сообщение')
  const tickets = await readJson(ticketsFile(), [])
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  const now = Date.now()
  ticket.messages.push(msg(from, authorId, authorName, t, now))
  ticket.updatedAt = now
  // Своя сторона, отправив сообщение, автоматически «прочитала» тикет до текущего момента.
  ticket.reads = ticket.reads || {}
  ticket.reads[from === 'support' ? 'support' : 'user'] = now
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
