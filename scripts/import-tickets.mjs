/**
 * РАЗОВЫЙ перенос обращений поддержки из файла в общую базу (MR-186, 27.08).
 *
 * Запускать ВРУЧНУЮ и ТОЛЬКО на том сервере, где лежит боевой server/data/tickets.json:
 *
 *     node scripts/import-tickets.mjs          # показать, что будет перенесено
 *     node scripts/import-tickets.mjs --apply  # перенести
 *
 * Почему это отдельный скрипт, а не перенос при первом чтении. Локальные копии
 * разработчиков ходят в ту же боевую базу, и файл обращений у каждого свой. Перенос «сам
 * собой» отдал бы победу тому, чья копия прочитала первой: его тестовые тикеты уехали бы
 * в прод, а настоящие серверные — уже нет, потому что таблица непустая и перенос считался
 * бы выполненным. Поэтому — руками, на нужной машине, с глазами.
 *
 * Повторный запуск безопасен: обращения и сообщения, которые уже есть в базе, пропускаются
 * по id. Ничего не удаляется и не перезаписывается — файл после переноса остаётся на месте.
 */
import 'dotenv/config'
import { dataPath, readJson } from '../server/lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from '../server/lib/supabase.js'

const apply = process.argv.includes('--apply')

if (!supabaseEnabled()) {
  console.error('База выключена (нет DATA_BACKEND=supabase или ключей). Переносить некуда.')
  process.exit(1)
}
const db = getSupabase()
const file = process.env.TICKETS_FILE || dataPath('tickets.json')
const tickets = await readJson(file, [])

if (!Array.isArray(tickets) || !tickets.length) {
  console.log(`В ${file} обращений нет — переносить нечего.`)
  process.exit(0)
}

const { data: existing, error } = await db.from('tickets').select('id')
if (error) {
  console.error('Не удалось прочитать таблицу обращений:', error.message)
  console.error('Скорее всего не применена миграция supabase/migrations/2026-08-27-tickets.sql')
  process.exit(1)
}
const have = new Set((existing || []).map((r) => r.id))
const fresh = tickets.filter((t) => t && t.id && !have.has(t.id))

console.log(`В файле обращений: ${tickets.length}`)
console.log(`Уже в базе:        ${tickets.length - fresh.length}`)
console.log(`К переносу:        ${fresh.length}`)
for (const t of fresh) {
  console.log(`  · ${t.id}  ${String(t.subject || '').slice(0, 50)}  (сообщений: ${(t.messages || []).length})`)
}
// Дедуп у переписки СВОЙ, по id сообщения, а не «по тикетам, которых ещё нет». Иначе
// после сбоя ровно между двумя вставками (обращения записались, переписка нет) второй
// запуск считал бы такие обращения уже перенесёнными и молча оставил бы их без единого
// сообщения — а пустая переписка выглядит как «клиент ничего не писал».
const { data: haveMsgs } = await db.from('ticket_messages').select('id')
const seenMsg = new Set((haveMsgs || []).map((r) => r.id))
const msgId = (t, m, i) => m.id || `${t.id}-m${i}-${m.ts || 0}`

const msgRows = tickets.flatMap((t) => (t.messages || [])
  .map((m, i) => ({ m, i }))
  .filter(({ m, i }) => !seenMsg.has(msgId(t, m, i)))
  .map(({ m, i }) => ({
    // У совсем старых записей id сообщения мог не сохраниться — собираем из тикета и времени.
    id: msgId(t, m, i),
    ticket_id: t.id,
    side: m.from === 'support' ? 'support' : 'user',
    author_id: m.authorId || null,
    author_name: m.authorName || null,
    author_email: m.authorEmail || null,
    text: String(m.text || ''),
    ts: Number(m.ts) || Number(t.createdAt) || Date.now(),
  })))
console.log(`Сообщений к переносу: ${msgRows.length}`)

if (!fresh.length && !msgRows.length) {
  console.log('Всё уже в базе — переносить нечего.')
  process.exit(0)
}
if (!apply) {
  console.log('\nЭто показ без записи. Чтобы перенести — запустите с --apply')
  process.exit(0)
}

const ticketRows = fresh.map((t) => ({
  id: t.id,
  user_id: t.userId || '—',
  subject: String(t.subject || 'Без темы'),
  category: String(t.category || 'tech'),
  status: String(t.status || 'open'),
  created_at: Number(t.createdAt) || Date.now(),
  updated_at: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
  read_user: Number(t.reads?.user) || 0,
  read_support: Number(t.reads?.support) || 0,
}))

if (ticketRows.length) {
  const { error: tErr } = await db.from('tickets').insert(ticketRows)
  if (tErr) { console.error('Обращения не перенесены:', tErr.message); process.exit(1) }
}

// Сообщения кладём ПОСЛЕ обращений: у них внешний ключ на tickets(id).
if (msgRows.length) {
  const { error: mErr } = await db.from('ticket_messages').insert(msgRows)
  if (mErr) {
    console.error('Обращения перенесены, но переписка — нет:', mErr.message)
    console.error('Запустите скрипт ещё раз: обращения будут пропущены, переписка допишется.')
    process.exit(1)
  }
}

console.log(`\nГотово: обращений ${ticketRows.length}, сообщений ${msgRows.length}.`)
console.log('Файл не тронут — он остаётся как резервная копия.')
