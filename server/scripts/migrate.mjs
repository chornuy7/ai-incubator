/**
 * ПРОГОНЯТОР МИГРАЦИЙ: применяет SQL-файлы из supabase/migrations по порядку.
 *
 * Зачем. До этого миграции накатывались руками через SQL Editor: копипаст из файла в
 * браузер. Работает, но ровно до первой забытой — а забытая миграция это не «неудобно»,
 * это разъехавшаяся схема на проде, которую замечают по странным ошибкам через неделю.
 * Здесь база сама помнит, что уже применено.
 *
 * ⚠️ ПЕРВЫЙ ЗАПУСК НА СУЩЕСТВУЮЩЕЙ БАЗЕ — ТОЛЬКО `--baseline`.
 * Часть наших миграций не идемпотентна: среди них есть `drop` (например
 * 2026-08-03-drop-users-stage4.sql). Переприменить их на живой базе значит снести данные.
 * `--baseline` записывает все нынешние файлы как применённые, НИЧЕГО не выполняя, — это
 * штатный способ подружить прогонятор с базой, которую наполняли руками.
 *
 *   node server/scripts/migrate.mjs --dry        показать, что будет применено
 *   node server/scripts/migrate.mjs --baseline   отметить всё нынешнее как применённое
 *   node server/scripts/migrate.mjs              применить неприменённое
 *
 * Подключение — прямой Postgres (SUPABASE_DB_URL), потому что Data API не умеет DDL:
 * сервисный ключ ходит по таблицам, а `create table` через него не выполнить.
 */
// Свой .env: скрипт запускают отдельно от сервера (`npm run migrate`), и без этого
// SUPABASE_DB_URL из файла не подхватится.
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations')

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const BASELINE = args.has('--baseline')

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('Нет SUPABASE_DB_URL. Supabase → Connect → Direct → Connection string, положить в .env.')
  process.exit(1)
}

/*
 * Прогонятор ходит к Postgres напрямую, портом 5432. Это не HTTP: окружения, где наружу
 * открыты только 80/443 (частый случай — CI-раннеры, контейнеры и песочницы), до базы не
 * достучатся, и ошибка будет выглядеть как ECONNREFUSED на непонятный адрес. Говорим об
 * этом прямо, чтобы человек не искал причину в пароле.
 */
process.on('uncaughtException', (e) => {
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ETIMEDOUT') {
    console.error(`Не удалось подключиться к базе (${e.code}, ${e.address || ''}:${e.port || 5432}).`)
    console.error('Порт 5432 должен быть открыт наружу. Если сеть пропускает только 80/443 —')
    console.error('возьмите строку Session pooler вместо Direct или запустите команду там, где доступ есть.')
    process.exit(1)
  }
  throw e
})

/** Файлы по имени: имена начинаются с даты, значит алфавитный порядок = хронологический. */
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const sum = (body) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()
try {
  await client.query(`create table if not exists schema_migrations (
    name       text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`)
  const { rows } = await client.query('select name, checksum from schema_migrations')
  const done = new Map(rows.map((r) => [r.name, r.checksum]))

  // Файл, изменённый ПОСЛЕ применения, — повод остановиться и разобраться: значит правили
  // уже накатанное, и что реально в базе — неизвестно. Молча пропускать такое нельзя.
  const changed = files.filter((f) => done.has(f) && done.get(f) !== sum(fs.readFileSync(path.join(DIR, f), 'utf8')))
  for (const f of changed) console.warn(`⚠  ${f} — файл изменился после применения. В базе то, что накатили раньше.`)

  /*
   * Заслон от «первого запуска на живой базе».
   *
   * Часть наших миграций не идемпотентна — среди них есть `drop`. Если прогонятор впервые
   * попал на базу, которую наполняли руками, его таблица учёта пуста, и обычный запуск
   * честно попытается применить ВСЁ с самого начала — то есть снесёт данные. Отличить
   * такую базу от чистой просто: на чистой нет наших таблиц. Видим `profiles` при пустом
   * учёте — останавливаемся и требуем `--baseline`.
   *
   * Это единственное место, где скрипт отказывается работать вместо того, чтобы сделать
   * как просили. Цена ошибки тут — прод, а не потраченная минута.
   */
  if (!DRY && !BASELINE && done.size === 0) {
    const { rows: [{ exists }] } = await client.query(
      "select exists (select 1 from information_schema.tables where table_schema='public' and table_name='profiles') as exists")
    if (exists) {
      console.error('База уже наполнена (есть таблица profiles), а учёт миграций пуст.')
      console.error('Это первый запуск прогонятора на существующей базе — сначала отметьте накатанное:')
      console.error('    node server/scripts/migrate.mjs --baseline')
      process.exit(1)
    }
  }

  const pending = files.filter((f) => !done.has(f))
  if (!pending.length) {
    console.log(`Все миграции применены (${files.length} шт.)${changed.length ? `, но ${changed.length} файл(ов) изменены после накатки` : ''}`)
    process.exit(changed.length ? 2 : 0)
  }

  if (DRY) {
    console.log(`К применению ${pending.length}:`)
    for (const f of pending) console.log('  ·', f)
    process.exit(0)
  }

  if (BASELINE) {
    for (const f of pending) {
      await client.query('insert into schema_migrations(name, checksum) values ($1,$2) on conflict (name) do nothing',
        [f, sum(fs.readFileSync(path.join(DIR, f), 'utf8'))])
    }
    console.log(`Отмечено как применённое без выполнения: ${pending.length}`)
    process.exit(0)
  }

  for (const f of pending) {
    const body = fs.readFileSync(path.join(DIR, f), 'utf8')
    // Каждая миграция — своя транзакция: упавшая не оставляет за собой половину.
    await client.query('begin')
    try {
      await client.query(body)
      await client.query('insert into schema_migrations(name, checksum) values ($1,$2)', [f, sum(body)])
      await client.query('commit')
      console.log('✓', f)
    } catch (e) {
      await client.query('rollback')
      console.error('✗', f, '—', e.message)
      console.error('Остановился: следующие миграции не применяю, чтобы не громоздить одну поломку на другую.')
      process.exit(1)
    }
  }
  console.log(`Готово: применено ${pending.length}`)
} finally {
  await client.end()
}
