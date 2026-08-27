/**
 * РАЗОВЫЙ перенос данных из файлов в общую базу (MR-186).
 *
 * Запускать ВРУЧНУЮ и ТОЛЬКО на том сервере, где лежат боевые server/data/*.json:
 *
 *     node scripts/import-to-db.mjs                # показать, что будет перенесено
 *     node scripts/import-to-db.mjs --apply        # перенести всё
 *     node scripts/import-to-db.mjs tickets        # только обращения
 *     node scripts/import-to-db.mjs worklog --apply
 *
 * Почему это отдельный скрипт, а не перенос при первом чтении. Локальные копии
 * разработчиков ходят в ту же боевую базу, а файлы у каждого свои. Перенос «сам собой»
 * отдал бы победу тому, чья копия прочитала первой: его тестовые записи уехали бы в прод,
 * а настоящие серверные — уже нет, потому что таблица непустая и перенос считался бы
 * выполненным. Поэтому — руками, на нужной машине, с глазами.
 *
 * Повторный запуск безопасен: всё, что уже есть в базе, пропускается по id. Ничего не
 * удаляется и не перезаписывается — файлы после переноса остаются как резервная копия.
 */
import 'dotenv/config'
import { dataPath, readJson } from '../server/lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from '../server/lib/supabase.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const only = args.filter((a) => !a.startsWith('--'))

if (!supabaseEnabled()) {
  console.error('База выключена (нет DATA_BACKEND=supabase или ключей). Переносить некуда.')
  process.exit(1)
}
const db = getSupabase()

/**
 * Один переезд. `rows` превращает содержимое файла в строки таблиц; порядок таблиц важен
 * там, где есть внешний ключ (сначала обращения, потом переписка).
 */
const STORES = {
  tickets: {
    title: 'обращения в поддержку',
    file: () => process.env.TICKETS_FILE || dataPath('tickets.json'),
    migration: '2026-08-27-tickets.sql',
    tables: ['tickets', 'ticket_messages'],
    rows: (tickets) => {
      // У совсем старых сообщений id мог не сохраниться — собираем из тикета и времени,
      // иначе повторный запуск не смог бы отличить их от новых и наплодил бы дублей.
      const msgId = (t, m, i) => m.id || `${t.id}-m${i}-${m.ts || 0}`
      return {
        tickets: tickets.filter((t) => t && t.id).map((t) => ({
          id: t.id,
          user_id: t.userId || '—',
          subject: String(t.subject || 'Без темы'),
          category: String(t.category || 'tech'),
          status: String(t.status || 'open'),
          created_at: Number(t.createdAt) || Date.now(),
          updated_at: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
          read_user: Number(t.reads?.user) || 0,
          read_support: Number(t.reads?.support) || 0,
        })),
        ticket_messages: tickets.filter((t) => t && t.id).flatMap((t) => (t.messages || []).map((m, i) => ({
          id: msgId(t, m, i),
          ticket_id: t.id,
          side: m.from === 'support' ? 'support' : 'user',
          author_id: m.authorId || null,
          author_name: m.authorName || null,
          author_email: m.authorEmail || null,
          text: String(m.text || ''),
          ts: Number(m.ts) || Number(t.createdAt) || Date.now(),
        }))),
      }
    },
  },
  worklog: {
    title: 'учёт рабочего времени',
    file: () => process.env.WORKLOG_FILE || dataPath('worklog.json'),
    migration: '2026-08-27-work-log.sql',
    tables: ['work_log'],
    rows: (entries) => ({
      work_log: entries.filter((e) => e && e.id && e.userId).map((e) => ({
        id: e.id,
        user_id: e.userId,
        start_at: Number(e.start) || 0,
        end_at: e.end == null ? null : Number(e.end),
        duration_ms: Number(e.durationMs) || 0,
      })),
    }),
  },
}

const picked = only.length ? only : Object.keys(STORES)
for (const key of picked) {
  if (!STORES[key]) {
    console.error(`Неизвестный стор «${key}». Есть: ${Object.keys(STORES).join(', ')}`)
    process.exit(1)
  }
}

let failed = false
for (const key of picked) {
  const store = STORES[key]
  console.log(`\n=== ${store.title} (${key}) ===`)
  const file = store.file()
  const content = await readJson(file, [])
  if (!Array.isArray(content) || !content.length) {
    console.log(`В ${file} записей нет — переносить нечего.`)
    continue
  }

  const planned = store.rows(content)
  // Дедуп СВОЙ у каждой таблицы, по её собственным id. «Раз обращение уже в базе,
  // значит и переписка тоже» — неверно: сбой ровно между двумя вставками оставил бы
  // обращения без единого сообщения, а пустая переписка выглядит как «клиент молчал».
  const toWrite = {}
  let total = 0
  let broken = false
  for (const table of store.tables) {
    const { data, error } = await db.from(table).select('id')
    if (error) {
      console.error(`Не удалось прочитать таблицу ${table}: ${error.message}`)
      console.error(`Скорее всего не применена миграция supabase/migrations/${store.migration}`)
      broken = true
      failed = true
      break
    }
    const have = new Set((data || []).map((r) => r.id))
    toWrite[table] = (planned[table] || []).filter((r) => !have.has(r.id))
    total += toWrite[table].length
    console.log(`  ${table}: в файле ${(planned[table] || []).length}, уже в базе ${have.size}, к переносу ${toWrite[table].length}`)
  }
  if (broken) continue

  if (!total) { console.log('  Всё уже в базе.'); continue }
  if (!apply) { console.log('  Это показ без записи. Чтобы перенести — добавьте --apply'); continue }

  let wrote = 0
  for (const table of store.tables) {
    const rows = toWrite[table]
    if (!rows.length) continue
    // Пишем частями: одна вставка на несколько тысяч строк упирается в лимит запроса.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(table).insert(rows.slice(i, i + 500))
      if (error) {
        console.error(`  ${table}: перенос прерван на строке ${i}: ${error.message}`)
        console.error('  Запустите скрипт ещё раз — записанное пропустится, остальное допишется.')
        failed = true
        break
      }
      wrote += Math.min(500, rows.length - i)
    }
  }
  console.log(`  Готово: перенесено строк ${wrote}. Файл не тронут — остаётся резервной копией.`)
}

console.log(failed ? '\nЗавершено С ОШИБКАМИ — смотрите сообщения выше.' : '\nЗавершено.')
process.exit(failed ? 1 : 0)
