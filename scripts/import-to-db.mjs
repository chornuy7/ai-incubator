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
import fs from 'node:fs/promises'
import path from 'node:path'
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
  knowledge: {
    title: 'база знаний целей',
    file: () => process.env.KB_FILE || dataPath('knowledge.json'),
    migration: '2026-08-27-knowledge-base.sql',
    tables: ['knowledge_base'],
    rows: (items) => ({
      knowledge_base: items.filter((k) => k && k.id && k.goalId).map((k) => ({
        id: k.id,
        goal_id: k.goalId,
        kind: ['text', 'file', 'image', 'link'].includes(k.kind) ? k.kind : 'text',
        title: String(k.title || ''),
        content: String(k.content || ''),
        file_ref: k.fileRef || null,
        url: k.url || null,
        scope: String(k.scope || 'all'),
        version: Number(k.version) || 1,
        created_at: Number(k.createdAt) || Date.now(),
        updated_at: Number(k.updatedAt) || Number(k.createdAt) || Date.now(),
      })),
    }),
  },
  kbfiles: {
    title: 'вложения базы знаний',
    migration: '2026-08-27-knowledge-base.sql',
    tables: ['kb_files'],
    // Единственный стор, который читает не JSON, а КАТАЛОГ: файлы лежали на диске
    // россыпью, и содержимое надо поднять в базу вместе с ними.
    readSource: async () => {
      const dir = process.env.KB_FILES_DIR || dataPath('kb-files')
      const names = await fs.readdir(dir).catch(() => [])
      const out = []
      for (const name of names) {
        if (!/^kbf_[a-z0-9]{8,}(\.[a-z0-9]{1,8})?$/i.test(name)) continue
        const buffer = await fs.readFile(path.join(dir, name)).catch(() => null)
        if (!buffer) continue
        const stat = await fs.stat(path.join(dir, name)).catch(() => null)
        out.push({ id: name, buffer, createdAt: stat ? Math.round(stat.mtimeMs) : Date.now() })
      }
      return out
    },
    rows: (files) => ({
      kb_files: files.map((f) => ({
        id: f.id,
        name: f.id,
        mime: MIME_BY_EXT[path.extname(f.id).toLowerCase()] || 'application/octet-stream',
        size_bytes: f.buffer.length,
        // bytea через REST ходит шестнадцатеричной строкой с префиксом \x — формат
        // самого Postgres (bytea_output = hex), тот же, что и в server/kbFiles.js.
        data: `\\x${f.buffer.toString('hex')}`,
        created_at: f.createdAt,
      })),
    }),
  },
  folders: {
    title: 'папки целей',
    file: () => process.env.TARGET_FOLDERS_FILE || dataPath('target-folders.json'),
    migration: '2026-08-27-target-folders.sql',
    tables: ['target_folders', 'target_folder_targets'],
    // У целей папки нет своего id — их опознаёт пара (папка, канал). Тот же ключ,
    // что и первичный в базе, поэтому повторный запуск ничего не задвоит.
    keys: { target_folder_targets: ['folder_id', 'username'] },
    // Файл папок — объект { folders: [...] }, а не массив, как у остальных сторов.
    readSource: async () => {
      const data = await readJson(process.env.TARGET_FOLDERS_FILE || dataPath('target-folders.json'), { folders: [] })
      return Array.isArray(data?.folders) ? data.folders : []
    },
    rows: (folders) => {
      const clean = (t) => String(t || '').trim().replace(/^@/, '').toLowerCase()
      const list = folders.filter((f) => f && f.id)
      return {
        target_folders: list.map((f) => ({
          id: f.id,
          user_id: f.userId || null,
          name: String(f.name || 'Без названия'),
          created_at: Number(f.createdAt) || Date.now(),
          updated_at: Number(f.updatedAt) || Number(f.createdAt) || Date.now(),
        })),
        target_folder_targets: list.flatMap((f) => {
          // Схлопываем регистр ЗДЕСЬ же: в старых папках лежат дубли, а база их
          // просто отвергнет — и перенос встанет на первой такой папке.
          const seen = new Set()
          const out = []
          for (const t of f.targets || []) {
            const username = clean(t)
            if (!username || seen.has(username)) continue
            seen.add(username)
            out.push({ folder_id: f.id, username, position: out.length })
          }
          return out
        }),
      }
    },
  },
}

/** Тип восстанавливаем по расширению: имя файла на диске — единственное, что о нём известно. */
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.csv': 'text/csv', '.md': 'text/markdown',
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
  const source = store.readSource ? await store.readSource() : await readJson(store.file(), [])
  const where = store.file ? store.file() : (process.env.KB_FILES_DIR || dataPath('kb-files'))
  if (!Array.isArray(source) || !source.length) {
    console.log(`В ${where} записей нет — переносить нечего.`)
    continue
  }

  const planned = store.rows(source)
  // Дедуп СВОЙ у каждой таблицы, по её собственным id. «Раз обращение уже в базе,
  // значит и переписка тоже» — неверно: сбой ровно между двумя вставками оставил бы
  // обращения без единого сообщения, а пустая переписка выглядит как «клиент молчал».
  const toWrite = {}
  let total = 0
  let broken = false
  for (const table of store.tables) {
    // По какому набору колонок узнаём «эта строка уже перенесена». Обычно это id,
    // но у таблиц-связок своего id нет — там опознаёт составной ключ.
    const key = store.keys?.[table] || ['id']
    const { data, error } = await db.from(table).select(key.join(','))
    if (error) {
      console.error(`Не удалось прочитать таблицу ${table}: ${error.message}`)
      console.error(`Скорее всего не применена миграция supabase/migrations/${store.migration}`)
      broken = true
      failed = true
      break
    }
    const identity = (r) => key.map((k) => r[k]).join(' ')
    const have = new Set((data || []).map(identity))
    toWrite[table] = (planned[table] || []).filter((r) => !have.has(identity(r)))
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
