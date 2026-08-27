/**
 * MR-186: обращения в поддержку переехали из файла в общую базу (27.08).
 *
 * Тесты `tickets.test.js` гоняют файловый режим — там опечатка в названии колонки
 * не видна вовсе. А цена такой опечатки высокая: на боевой клиент отправляет обращение,
 * запись не проходит, и человек остаётся без поддержки, ничего об этом не зная.
 *
 * Поэтому здесь сверяем ДВЕ стороны переезда друг с другом:
 *   • всё, что код пишет и читает, есть в миграции;
 *   • всё, что миграция требует обязательно, код действительно заполняет.
 *
 * Если вы сюда попали из-за красного теста — поменяли схему в одном месте из двух.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const sql = await fs.readFile(new URL('../../supabase/migrations/2026-08-27-tickets.sql', import.meta.url), 'utf8')
const code = await fs.readFile(new URL('../tickets.js', import.meta.url), 'utf8')

/** Колонки таблицы из `create table` в миграции: имя → определение строки. */
function columnsOf(table) {
  const at = sql.indexOf(`create table if not exists ${table} (`)
  assert.ok(at > 0, `в миграции нет таблицы ${table}`)
  const body = sql.slice(at + sql.slice(at).indexOf('(') + 1, at + sql.slice(at).indexOf('\n);'))
  const cols = new Map()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--') || line.startsWith('constraint')) continue
    const m = line.match(/^([a-z][a-z0-9_]*)\s+(.+?),?$/)
    if (m) cols.set(m[1], m[2])
  }
  return cols
}

const tickets = columnsOf('tickets')
const messages = columnsOf('ticket_messages')
const known = new Set([...tickets.keys(), ...messages.keys()])

/**
 * Имена колонок, которыми оперирует код: ключи объектов вида `user_id:` и строковые
 * ключи вида `'read_support'`. Локальные имена в проекте camelCase, поэтому всё
 * подчёркнутое в позиции ключа — это обращение к базе, а не к своей переменной.
 */
function columnsUsedInCode() {
  const used = new Set()
  for (const m of code.matchAll(/(?:^|[{,(\s])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/gm)) used.add(m[1])
  for (const m of code.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)) used.add(m[1])
  // `.eq('id', …)`, `.order('ts', …)` — короткие имена без подчёркивания ловим отдельно.
  for (const m of code.matchAll(/\.(?:eq|order|like|in)\('([a-z_]+)'/g)) used.add(m[1])
  return used
}

test('код не обращается к колонкам, которых нет в миграции', () => {
  // Имена таблиц и служебные строки колонками не являются.
  const notColumns = new Set(['ticket_messages', 'schema cache'])
  const unknown = [...columnsUsedInCode()].filter((c) => !known.has(c) && !notColumns.has(c))
  assert.deepEqual(unknown, [], [
    'В tickets.js есть колонки, которых нет в 2026-08-27-tickets.sql.',
    'На боевой это тихая ошибка записи: обращение клиента не сохранится.',
    'Лишние:', ...unknown.map((c) => '  · ' + c),
  ].join('\n'))
})

test('обязательные колонки заполняются при создании обращения', () => {
  const required = [...tickets].filter(([, def]) => /not null/i.test(def) && !/default/i.test(def)).map(([c]) => c)
  const row = code.slice(code.indexOf('const ticketToRow'), code.indexOf('const ticketToRow') + 400)
  const missing = required.filter((c) => !new RegExp(`\\b${c}\\s*:`).test(row))
  assert.deepEqual(missing, [], `ticketToRow не заполняет обязательные колонки: ${missing.join(', ')}`)
})

test('обязательные колонки заполняются при отправке сообщения', () => {
  const required = [...messages].filter(([, def]) => /not null/i.test(def) && !/default/i.test(def)).map(([c]) => c)
  const row = code.slice(code.indexOf('const msgToRow'), code.indexOf('const msgToRow') + 400)
  const missing = required.filter((c) => !new RegExp(`\\b${c}\\s*:`).test(row))
  assert.deepEqual(missing, [], `msgToRow не заполняет обязательные колонки: ${missing.join(', ')}`)
})

test('статусы обращения совпадают в коде и в ограничении базы', () => {
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

test('переписка лежит строками, а не полем-JSON', () => {
  // Правило владельца с созвона 24.08: «JSON в базе = ошибка». Сообщение — это данные
  // со своим автором и временем, по ним считают непрочитанное; складывать их в одно
  // поле значит лишить базу возможности их отличать.
  assert.ok(/create table if not exists ticket_messages/.test(sql), 'переписка должна быть отдельной таблицей')
  assert.ok(!/jsonb/i.test(sql), 'в схеме обращений не должно быть jsonb-полей')
  assert.ok(messages.has('side') && messages.has('ts') && messages.has('author_name'),
    'у сообщения должны быть своя сторона, время и автор на момент отправки')
})
