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
/** Что накатили руками до появления прогонятора — список в git, а не догадка. */
const BASELINE_FILE = path.join(__dirname, '..', '..', 'supabase', 'baseline.txt')

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
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(e?.code)) {
    console.error(`Не удалось подключиться к базе (${e.code}, ${e.address || ''}:${e.port || 5432}).`)
    // Ловушка Supabase: Direct connection живёт ТОЛЬКО в IPv6. Там, где IPv6 нет
    // (GitHub-раннеры — как раз такой случай), нужен Session pooler по IPv4.
    if (String(e.address || '').includes(':')) {
      console.error('Адрес IPv6, а сеть его не умеет — обычное дело для CI-раннеров.')
      console.error('Возьмите строку Session pooler (Supabase → Connect → Direct → Session pooler):')
      console.error('  postgresql://postgres.<ref>:ПАРОЛЬ@aws-0-<регион>.pooler.supabase.com:5432/postgres')
      process.exit(1)
    }
    console.error('Порт 5432 должен быть открыт наружу. Если сеть пропускает только 80/443 —')
    console.error('возьмите строку Session pooler вместо Direct или запустите команду там, где доступ есть.')
    process.exit(1)
  }
  throw e
})

/** Файлы по имени: имена начинаются с даты, значит алфавитный порядок = хронологический. */
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
/*
 * Сумму считаем по тексту БЕЗ возвратов каретки.
 *
 * Первый прогон в Actions обвинил семь файлов в том, что их правили после применения.
 * На деле их никто не трогал: git на Windows отдаёт CRLF, на раннере — LF, байты разные,
 * файл один и тот же. Сумма, чувствительная к переводу строк, в смешанной команде будет
 * кричать «волк» на каждом запуске — и на неё перестанут смотреть.
 */
const sum = (body) => crypto.createHash('sha256').update(String(body).split(String.fromCharCode(13)).join('')).digest('hex').slice(0, 16)

/*
 * Строку подключения чаще всего портят при копировании: попадает лишний текст, перенос
 * строки или кавычки. Драйвер в таком случае молча берёт огрызок и падает с
 * «getaddrinfo EAI_AGAIN base» — по такой ошибке причину не найти. Проверяем форму сами
 * и называем, что именно не так.
 */
try {
  const u = new URL(url)
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('ожидался postgresql://, а не ' + u.protocol + '//')
  if (!u.hostname.includes('.')) throw new Error('хост получился «' + u.hostname + '» — похоже, в значение попал лишний текст или перенос строки')
  // Плейсхолдер из интерфейса Supabase — [YOUR-PASSWORD] — часто оставляют вместе со
  // скобками: строка при этом выглядит правильной, а пароль неверный.
  const pwd = decodeURIComponent(u.password)
  if (pwd.includes(String.fromCharCode(91)) || pwd.includes(String.fromCharCode(93))) throw new Error('в пароле остались квадратные скобки — это плейсхолдер из интерфейса, уберите их')
  if (!u.password) throw new Error('в строке нет пароля — подставьте его вместо [YOUR-PASSWORD]')
} catch (e) {
  console.error('SUPABASE_DB_URL не похож на строку подключения:', e.message)
  console.error('Ожидается ОДНОЙ строкой, без кавычек и пробелов:')
  console.error('  postgresql://postgres:ПАРОЛЬ@db.<ref>.supabase.co:5432/postgres')
  process.exit(1)
}

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
   * Первый запуск на живой базе.
   *
   * Часть наших миграций не идемпотентна — среди них есть `drop`. Если прогонятор впервые
   * попал на базу, которую наполняли руками через SQL Editor, его учёт пуст, и обычный
   * запуск честно попытался бы применить ВСЁ с самого начала — то есть снёс бы данные.
   *
   * Что уже накатано руками, знает не догадка, а СПИСОК В РЕПОЗИТОРИИ (supabase/baseline.txt):
   * он в git, его видно в ревью, и это не магия «база выглядит непустой — наверное, всё
   * применено». Файлы из списка отмечаются как применённые без выполнения, всё остальное
   * едет обычным порядком. Так деплою не нужен ручной шаг.
   *
   * Списка нет, а база уже наполнена — останавливаемся и требуем `--baseline` явно: это
   * единственное место, где скрипт отказывается работать вместо того, чтобы сделать как
   * просили. Цена ошибки тут — прод, а не потраченная минута.
   */
  if (!DRY && !BASELINE && done.size === 0) {
    const { rows: [{ exists }] } = await client.query(
      "select exists (select 1 from information_schema.tables where table_schema='public' and table_name='profiles') as exists")
    if (exists) {
      const listed = fs.existsSync(BASELINE_FILE)
        ? fs.readFileSync(BASELINE_FILE, 'utf8').split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        : []
      const known = listed.filter((f) => files.includes(f))
      if (!known.length) {
        console.error('База уже наполнена (есть таблица profiles), а учёт миграций пуст.')
        console.error('Первый запуск на существующей базе — отметьте накатанное явно:')
        console.error('    node server/scripts/migrate.mjs --baseline')
        process.exit(1)
      }
      for (const f of known) {
        await client.query('insert into schema_migrations(name, checksum) values ($1,$2) on conflict (name) do nothing',
          [f, sum(fs.readFileSync(path.join(DIR, f), 'utf8'))])
        done.set(f, null)
      }
      console.log(`Учёт заведён по supabase/baseline.txt: ${known.length} миграц(ий) отмечено накатанными ранее (не выполнялись).`)
    }
  }

  const pending = files.filter((f) => !done.has(f))
  if (!pending.length) {
    console.log(`Все миграции применены (${files.length} шт.)${changed.length ? `, но ${changed.length} файл(ов) изменены после накатки` : ''}`)
    process.exit(changed.length && DRY ? 2 : 0)
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
