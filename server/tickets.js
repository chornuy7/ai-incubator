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

/**
 * @param {'user'|'support'} from
 * @param {{id?:string, name?:string, email?:string}} author автор на момент отправки
 */
const msg = (from, author, text, ts) => ({
  id: `m${ts}${Math.floor(ts % 1000)}`,
  from: from === 'support' ? 'support' : 'user',
  authorId: author?.id || '—',
  // Денормализуем автора в момент отправки: в чате должно быть видно КТО написал —
  // почта/имя человека, а не роль. Для поддержки — «Поддержка».
  authorName: String(author?.name || (from === 'support' ? 'Поддержка' : 'Клиент')).trim(),
  authorEmail: String(author?.email || '').trim(),
  text: String(text).trim(),
  ts,
})

/**
 * Разовая починка старых записей. До 12.08 ответ АВТОРА тикета сохранялся как `support`
 * (роль определялась по правам, а не по тому, кем человек пишет) — в переписке все
 * реплики выглядели как «Поддержка», включая свои. Распознаём такие по автору: если
 * писал сам владелец тикета, это сообщение клиента. Трогаем только legacy-записи (без
 * `authorName`) — новые сохраняются уже правильно. @returns {boolean} чинили ли что-то
 */
function healLegacyAuthors(tickets) {
  let changed = false
  for (const t of tickets || []) {
    for (const m of t.messages || []) {
      if (m.authorName) continue // новая запись — не трогаем
      if (m.from === 'support' && m.authorId && m.authorId !== '—' && m.authorId === t.userId) {
        m.from = 'user'
        changed = true
      }
    }
  }
  return changed
}

/** Единая точка чтения: чинит legacy-авторов и сохраняет результат один раз. */
async function readTickets() {
  const tickets = await readJson(ticketsFile(), [])
  if (healLegacyAuthors(tickets)) {
    try { await writeJson(ticketsFile(), tickets) } catch { /* починка не должна ронять чтение */ }
  }
  return tickets
}

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
  const tickets = await readTickets()
  const rows = all ? tickets : tickets.filter((t) => t.userId === userId)
  return rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getTicket(id) {
  const tickets = await readTickets()
  return tickets.find((t) => t.id === id) || null
}

export async function createTicket({ userId = '', author = null, subject = '', category = 'tech', body = '' }) {
  const subj = String(subject || '').trim()
  if (!subj) throw new Error('Укажите тему обращения')
  const tickets = await readTickets()
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
  if (text) ticket.messages.push(msg('user', { id: userId, ...(author || {}) }, text, now))
  tickets.push(ticket)
  await writeJson(ticketsFile(), tickets)
  return ticket
}

/** Отметить тикет прочитанным для стороны (обнуляет её счётчик непрочитанного). */
export async function markRead(id, side) {
  const tickets = await readTickets()
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
export async function addMessage(id, { from = 'user', author = null, text = '' }) {
  const t = String(text || '').trim()
  if (!t) throw new Error('Пустое сообщение')
  const tickets = await readTickets()
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  const now = Date.now()
  ticket.messages.push(msg(from, author, t, now))
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
  const tickets = await readTickets()
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  ticket.status = status
  ticket.updatedAt = Date.now()
  await writeJson(ticketsFile(), tickets)
  return ticket
}
