/**
 * MR-186: сторы переезжают из файлов в общую базу. Здесь сверяются ДВЕ стороны переезда.
 *
 * Обычные тесты сторов гоняют файловый режим — в нём опечатка в имени колонки не видна
 * вовсе, всё зелено. А цена такой опечатки высокая: на боевой запись молча не проходит.
 * Клиент отправил обращение и остался без поддержки; оператор отметил выход, а смена
 * не закрылась. Узнаём об этом от людей, а не от тестов.
 *
 * Поэтому проверяем:
 *   • всё, к чему код обращается по имени, есть в миграции;
 *   • всё, что миграция требует обязательно, код действительно заполняет.
 *
 * Новый переезд — добавьте строку в STORES ниже, больше ничего писать не надо.
 * Если тест покраснел — схему поменяли в одном месте из двух.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

/** @type {Array<{name:string, sql:string, code:string, tables:string[], notColumns?:string[]}>} */
const STORES = [
  {
    name: 'обращения в поддержку',
    sql: '2026-08-27-tickets.sql',
    code: 'tickets.js',
    tables: ['tickets', 'ticket_messages'],
    // Имя второй таблицы встречается в коде как строка — колонкой оно не является.
    notColumns: ['ticket_messages', 'schema cache'],
  },
  {
    name: 'учёт рабочего времени',
    sql: '2026-08-27-work-log.sql',
    code: 'workLog.js',
    tables: ['work_log'],
    notColumns: ['work_log', 'schema cache'],
  },
  {
    name: 'база знаний',
    sql: '2026-08-27-knowledge-base.sql',
    code: 'knowledgeBase.js',
    tables: ['knowledge_base'],
    notColumns: ['knowledge_base', 'schema cache'],
  },
  {
    name: 'вложения базы знаний',
    sql: '2026-08-27-knowledge-base.sql',
    code: 'kbFiles.js',
    tables: ['kb_files'],
    notColumns: ['kb_files', 'schema cache'],
  },
]

const readSql = (f) => fs.readFile(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')
const readCode = (f) => fs.readFile(new URL(`../${f}`, import.meta.url), 'utf8')

/** Колонки таблицы из `create table` в миграции: имя → остаток строки с типом и флагами. */
function columnsOf(sql, table) {
  const at = sql.indexOf(`create table if not exists ${table} (`)
  assert.ok(at > 0, `в миграции нет таблицы ${table}`)
  const rest = sql.slice(at)
  const body = rest.slice(rest.indexOf('(') + 1, rest.indexOf('\n);'))
  const cols = new Map()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--') || line.startsWith('constraint')) continue
    const m = line.match(/^([a-z][a-z0-9_]*)\s+(.+?),?$/)
    if (m) cols.set(m[1], m[2])
  }
  assert.ok(cols.size, `у таблицы ${table} не разобрана ни одна колонка`)
  return cols
}

/**
 * Имена колонок, которыми оперирует код: ключи объектов вида `user_id:`, строковые
 * литералы `'read_support'` и короткие имена в фильтрах `.eq('id', …)`.
 * Локальные имена в проекте camelCase, поэтому всё подчёркнутое в позиции ключа —
 * это обращение к базе, а не к своей переменной.
 */
function columnsUsedInCode(code) {
  const used = new Set()
  for (const m of code.matchAll(/(?:^|[{,(\s])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/gm)) used.add(m[1])
  for (const m of code.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)) used.add(m[1])
  for (const m of code.matchAll(/\.(?:eq|neq|order|like|ilike|in|is|gt|gte|lt|lte)\('([a-z_]+)'/g)) used.add(m[1])
  return used
}

for (const store of STORES) {
  test(`${store.name}: код не обращается к колонкам, которых нет в миграции`, async () => {
    const sql = await readSql(store.sql)
    const code = await readCode(store.code)
    const known = new Set(store.tables.flatMap((t) => [...columnsOf(sql, t).keys()]))
    const skip = new Set(store.notColumns || [])
    const unknown = [...columnsUsedInCode(code)].filter((c) => !known.has(c) && !skip.has(c))
    assert.deepEqual(unknown, [], [
      `В ${store.code} есть колонки, которых нет в ${store.sql}.`,
      'На боевой это тихая ошибка записи — данные не сохранятся, и никто не узнает.',
      'Лишние:', ...unknown.map((c) => '  · ' + c),
    ].join('\n'))
  })

  test(`${store.name}: обязательные колонки где-то заполняются`, async () => {
    const sql = await readSql(store.sql)
    const code = await readCode(store.code)
    const missing = []
    for (const table of store.tables) {
      for (const [col, def] of columnsOf(sql, table)) {
        // Колонку с DEFAULT база заполнит сама; остальные обязана заполнить запись.
        if (!/not null/i.test(def) || /default/i.test(def)) continue
        if (!new RegExp(`\\b${col}\\s*:`).test(code)) missing.push(`${table}.${col}`)
      }
    }
    assert.deepEqual(missing, [], [
      `${store.code} не заполняет обязательные колонки: ${missing.join(', ')}`,
      'База отвергнет такую вставку целиком.',
    ].join('\n'))
  })
}

test('обращения: статусы совпадают в коде и в ограничении базы', async () => {
  const sql = await readSql('2026-08-27-tickets.sql')
  const code = await readCode('tickets.js')
  const chk = sql.match(/tickets_status_chk check \(status in \(([^)]+)\)\)/)
  assert.ok(chk, 'в миграции нет проверки статусов')
  const inSql = chk[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  const inCode = code.match(/export const TICKET_STATUSES = \[([^\]]+)\]/)[1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  assert.deepEqual(inSql, inCode, [
    'Список статусов разошёлся. База отвергнет статус, которого нет в её проверке,',
    'и перевод обращения молча не сохранится.',
  ].join('\n'))
})

test('обращения: переписка лежит строками, а не полем-JSON', async () => {
  // Правило владельца с созвона 24.08: «JSON в базе = ошибка». Сообщение — это данные
  // со своим автором и временем, по ним считают непрочитанное; складывать их в одно
  // поле значит лишить базу возможности их различать.
  const sql = await readSql('2026-08-27-tickets.sql')
  assert.ok(/create table if not exists ticket_messages/.test(sql), 'переписка должна быть отдельной таблицей')
  assert.ok(!/jsonb/i.test(sql), 'в схеме обращений не должно быть jsonb-полей')
  const messages = columnsOf(sql, 'ticket_messages')
  assert.ok(messages.has('side') && messages.has('ts') && messages.has('author_name'),
    'у сообщения должны быть своя сторона, время и автор на момент отправки')
})

test('учёт времени: открытая смена отличима от закрытой', async () => {
  // На этом держится и «человек на смене прямо сейчас», и закрытие выхода: без NULL
  // пришлось бы городить признак-флаг и следить, чтобы он не разошёлся с временем.
  const sql = await readSql('2026-08-27-work-log.sql')
  const cols = columnsOf(sql, 'work_log')
  assert.ok(cols.has('end_at'), 'нужна колонка окончания смены')
  assert.ok(!/not null/i.test(cols.get('end_at')), 'открытая смена — это end_at IS NULL, колонка обязана допускать NULL')
})

test('база знаний: вложения лежат в базе, а не на диске сервера', async () => {
  // Суть переезда: файл на диске одного инстанса для второго не существует — запись
  // базы знаний есть, ссылка есть, а вложение не открывается.
  const sql = await readSql('2026-08-27-knowledge-base.sql')
  const cols = columnsOf(sql, 'kb_files')
  assert.ok(/bytea/i.test(cols.get('data') || ''), 'содержимое файла должно храниться колонкой bytea')
  const code = await readCode('kbFiles.js')
  assert.ok(/supabaseEnabled\(\)/.test(code), 'у стора вложений должна быть ветка базы, а не только диск')
})

test('база знаний: вид записи ограничен и в коде, и в базе', async () => {
  const sql = await readSql('2026-08-27-knowledge-base.sql')
  const chk = sql.match(/knowledge_base_kind_chk check \(kind in \(([^)]+)\)\)/)
  assert.ok(chk, 'в миграции нет проверки вида записи')
  const inSql = chk[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  const code = await readCode('knowledgeBase.js')
  const inCode = code.match(/\['text', 'file', 'image', 'link'\]/)
  assert.ok(inCode, 'список видов в normalizeKb не найден')
  assert.deepEqual(inSql, ['file', 'image', 'link', 'text'], 'база отвергнет вид, которого нет в её проверке')
})
