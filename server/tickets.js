/**
 * §8 (MR-44): тикеты поддержки — обращения клиента и переписка с поддержкой.
 *
 * С 27.08 (MR-186) хранятся в ОБЩЕЙ БАЗЕ. До этого стор писал только в
 * `server/data/tickets.json`, ветки Supabase у него не было вовсе — а это переписка
 * живых людей: пропал диск сервера, и обращений с ответами больше нет. Второй инстанс
 * платформы делил бы обращения пополам: клиент пишет на один сервер, поддержка смотрит
 * на другой и тикета не видит.
 *
 * Переписка лежит ОТДЕЛЬНОЙ таблицей (`ticket_messages`), по строке на сообщение, а не
 * полем-JSON: у сообщения свой автор, сторона и время, по нему считают непрочитанное и
 * сортируют. Правило владельца — «JSON в базе = ошибка» — как раз про такие случаи.
 *
 * Файловый режим (без DATA_BACKEND=supabase) оставлен как у остальных сторов: локальный
 * запуск и тесты работают без базы. Форма записи наружу в обоих режимах одинаковая.
 *
 * Модель тикета:
 *   { id, userId, subject, category, status, createdAt, updatedAt,
 *     reads: { user, support },
 *     messages: [{ id, from:'user'|'support', authorId, authorName, authorEmail, text, ts }] }
 */
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

const ticketsFile = () => process.env.TICKETS_FILE || dataPath('tickets.json')
function sb() { return supabaseEnabled() ? getSupabase() : null }

export const TICKET_STATUSES = ['open', 'progress', 'waiting', 'escalated', 'closed']
const STATUS_SET = new Set(TICKET_STATUSES)

/**
 * Таблиц ещё нет (миграция не накатана) — не роняем поддержку. Ведём себя как пустой
 * список: обращений не видно, но страница откроется и остальная панель работает.
 */
const isMissingTable = (error) =>
  !!error && /tickets|ticket_messages|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

/** Короткий, но уникальный в пределах стора id (по времени создания). */
function genId(now, existing) {
  let id = `TK-${String(now).slice(-6)}`
  let n = 1
  while (existing.some((t) => (t.id || t) === id)) id = `TK-${String(now).slice(-6)}-${n++}`
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

// ─── база ────────────────────────────────────────────────────────────────────

const rowToTicket = (r, messages = []) => ({
  id: r.id,
  userId: r.user_id,
  toOwnerId: r.to_owner_id || null, // MR-257: адресат — владелец пространства или (пусто) поддержка

  subject: r.subject,
  category: r.category,
  status: r.status,
  createdAt: Number(r.created_at) || 0,
  updatedAt: Number(r.updated_at) || 0,
  reads: { user: Number(r.read_user) || 0, support: Number(r.read_support) || 0 },
  messages,
})

const rowToMsg = (m) => ({
  id: m.id,
  from: m.side === 'support' ? 'support' : 'user',
  authorId: m.author_id || '—',
  authorName: m.author_name || '',
  authorEmail: m.author_email || '',
  text: m.text || '',
  ts: Number(m.ts) || 0,
})

const msgToRow = (ticketId, m) => ({
  id: m.id,
  ticket_id: ticketId,
  side: m.from === 'support' ? 'support' : 'user',
  author_id: m.authorId || null,
  author_name: m.authorName || null,
  author_email: m.authorEmail || null,
  text: m.text,
  ts: m.ts,
})

const ticketToRow = (t) => ({
  id: t.id,
  user_id: t.userId,
  // MR-257: кому адресовано. Пусто — платформенной поддержке (как было), иначе — владельцу
  // пространства. Без этого поля сотрудник физически не мог написать СВОЕМУ администратору:
  // все обращения шли к нам, а поддержка отправляла его обратно к владельцу.
  to_owner_id: t.toOwnerId || null,
  subject: t.subject,
  category: t.category,
  status: t.status,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
  read_user: t.reads?.user || 0,
  read_support: t.reads?.support || 0,
})

/**
 * Дочитать переписку к уже выбранным тикетам ОДНИМ запросом, а не по запросу на тикет:
 * на странице поддержки тикетов десятки, и запрос в цикле превратил бы её в лесенку.
 */
async function withMessages(db, rows) {
  if (!rows.length) return []
  const { data, error } = await db
    .from('ticket_messages')
    .select('*')
    .in('ticket_id', rows.map((r) => r.id))
    .order('ts', { ascending: true })
  if (error && !isMissingTable(error)) throw new Error(`Не удалось прочитать переписку: ${error.message}`)
  const byTicket = new Map()
  for (const m of data || []) {
    if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, [])
    byTicket.get(m.ticket_id).push(rowToMsg(m))
  }
  return rows.map((r) => rowToTicket(r, byTicket.get(r.id) || []))
}

/** Прочитать один тикет из базы вместе с перепиской. */
async function dbTicket(db, id) {
  const { data, error } = await db.from('tickets').select('*').eq('id', String(id)).limit(1)
  if (error) {
    if (isMissingTable(error)) return null
    throw new Error(`Не удалось прочитать обращение: ${error.message}`)
  }
  const [ticket] = await withMessages(db, data || [])
  return ticket || null
}

/** Записать поля тикета. Ошибку «нет таблицы» глушим — как и при чтении. */
async function dbPatch(db, id, patch) {
  const { error } = await db.from('tickets').update(patch).eq('id', String(id))
  if (error && !isMissingTable(error)) throw new Error(`Не удалось сохранить обращение: ${error.message}`)
}

// ─── файловый режим ──────────────────────────────────────────────────────────

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

/** Единая точка чтения файла: чинит legacy-авторов и сохраняет результат один раз. */
async function readTickets() {
  const tickets = await readJson(ticketsFile(), [])
  if (healLegacyAuthors(tickets)) {
    try { await writeJson(ticketsFile(), tickets) } catch { /* починка не должна ронять чтение */ }
  }
  return tickets
}

// ─── публичный API ───────────────────────────────────────────────────────────

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

/**
 * @param {{userId?:string, all?:boolean, ownerId?:string}} p
 *   `ownerId` — MR-257: вернуть ещё и обращения, АДРЕСОВАННЫЕ этому владельцу. Свои
 *   обращения человек видит по userId, а запросы своих сотрудников — по этому полю.
 */
export async function listTickets({ userId = '', all = false, ownerId = '' } = {}) {
  const db = sb()
  if (db) {
    let q = db.from('tickets').select('*').order('updated_at', { ascending: false })
    if (!all) {
      q = ownerId
        ? q.or(`user_id.eq.${userId || '—'},to_owner_id.eq.${ownerId}`)
        : q.eq('user_id', userId || '—')
    }
    const { data, error } = await q
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать обращения: ${error.message}`)
    }
    return withMessages(db, data || [])
  }
  const tickets = await readTickets()
  const rows = all
    ? tickets
    : tickets.filter((t) => t.userId === userId || (ownerId && t.toOwnerId === ownerId))
  return rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getTicket(id) {
  const db = sb()
  if (db) return dbTicket(db, id)
  const tickets = await readTickets()
  return tickets.find((t) => t.id === id) || null
}

export async function createTicket({ userId = '', author = null, subject = '', category = 'tech', body = '', toOwnerId = '' }) {
  const subj = String(subject || '').trim()
  if (!subj) throw new Error('Укажите тему обращения')
  const db = sb()
  const now = Date.now()
  // Занятые id ищем только среди созданных в ту же миллисекунду: читать ради номера
  // все обращения разом не нужно, а совпасть они могут только по времени создания.
  let taken = []
  if (db) {
    const { data } = await db.from('tickets').select('id').like('id', `TK-${String(now).slice(-6)}%`)
    taken = (data || []).map((r) => r.id)
  } else {
    taken = (await readTickets()).map((t) => t.id)
  }
  const ticket = {
    id: genId(now, taken),
    userId: userId || '—',
    // MR-257: адресат. Сотрудник пишет владельцу, клиент платформы — поддержке.
    toOwnerId: String(toOwnerId || '') || null,
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

  if (db) {
    const { error } = await db.from('tickets').insert(ticketToRow(ticket))
    if (error) {
      if (isMissingTable(error)) throw new Error('Обращения временно недоступны: не применена миграция базы')
      throw new Error(`Не удалось создать обращение: ${error.message}`)
    }
    if (ticket.messages.length) {
      const { error: mErr } = await db.from('ticket_messages').insert(ticket.messages.map((m) => msgToRow(ticket.id, m)))
      if (mErr && !isMissingTable(mErr)) throw new Error(`Не удалось сохранить обращение: ${mErr.message}`)
    }
    return ticket
  }
  const tickets = await readTickets()
  tickets.push(ticket)
  await writeJson(ticketsFile(), tickets)
  return ticket
}

/** Отметить тикет прочитанным для стороны (обнуляет её счётчик непрочитанного). */
export async function markRead(id, side) {
  const key = side === 'support' ? 'support' : 'user'
  const now = Date.now()
  const db = sb()
  if (db) {
    const ticket = await dbTicket(db, id)
    if (!ticket) return null
    await dbPatch(db, id, { [key === 'support' ? 'read_support' : 'read_user']: now })
    ticket.reads[key] = now
    return ticket
  }
  const tickets = await readTickets()
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) return null
  ticket.reads = ticket.reads || {}
  ticket.reads[key] = now
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
  const now = Date.now()
  const side = from === 'support' ? 'support' : 'user'
  const db = sb()
  const ticket = db ? await dbTicket(db, id) : (await readTickets()).find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')

  const message = msg(from, author, t, now)
  ticket.messages.push(message)
  ticket.updatedAt = now
  // Своя сторона, отправив сообщение, автоматически «прочитала» тикет до текущего момента.
  ticket.reads = ticket.reads || {}
  ticket.reads[side] = now
  if (side === 'support') { if (ticket.status === 'open' || ticket.status === 'waiting') ticket.status = 'progress' }
  else if (ticket.status === 'closed') ticket.status = 'open'

  if (db) {
    const { error } = await db.from('ticket_messages').insert(msgToRow(ticket.id, message))
    if (error && !isMissingTable(error)) throw new Error(`Не удалось отправить сообщение: ${error.message}`)
    await dbPatch(db, ticket.id, {
      updated_at: now,
      status: ticket.status,
      [side === 'support' ? 'read_support' : 'read_user']: now,
    })
    return ticket
  }
  const tickets = await readTickets()
  const idx = tickets.findIndex((x) => x.id === id)
  tickets[idx] = ticket
  await writeJson(ticketsFile(), tickets)
  return ticket
}

export async function setStatus(id, status) {
  if (!STATUS_SET.has(status)) throw new Error('Неизвестный статус')
  const now = Date.now()
  const db = sb()
  if (db) {
    const ticket = await dbTicket(db, id)
    if (!ticket) throw new Error('Тикет не найден')
    await dbPatch(db, id, { status, updated_at: now })
    return { ...ticket, status, updatedAt: now }
  }
  const tickets = await readTickets()
  const ticket = tickets.find((x) => x.id === id)
  if (!ticket) throw new Error('Тикет не найден')
  ticket.status = status
  ticket.updatedAt = now
  await writeJson(ticketsFile(), tickets)
  return ticket
}
