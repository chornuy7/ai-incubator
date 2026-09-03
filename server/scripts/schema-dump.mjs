/**
 * СНИМОК СХЕМЫ: пересобирает supabase/schema.sql из живой базы (MR-290).
 *
 * Зачем. Прежний schema.sql писали руками, и он отстал: описывал 14 таблиц из 52 и
 * содержал parsed_channels, удалённую ещё в августе. Файл, которому нельзя верить, хуже
 * отсутствующего — по нему сверяются, а он врёт. Теперь снимок собирает сама база из
 * своих каталогов, и разойтись ему не с чем.
 *
 * Файл — СПРАВКА И ЭТАЛОН ДЛЯ СВЕРКИ, а не способ применения: схему меняют миграции из
 * supabase/migrations. Порядок такой: миграция → npm run migrate → npm run db:schema,
 * и оба файла едут одним PR. Тогда в ревью видно не только «что накатили», но и «во что
 * это превратило схему».
 *
 *   npm run db:schema             пересобрать supabase/schema.sql
 *   npm run db:schema -- --check  НЕ писать, а сравнить: разошлось — код возврата 2
 *
 * `--check` нужен деплою: он ловит правку схемы мимо миграций (кто-то сходил в SQL
 * Editor руками). Именно так на проде оказались daily_actions, trust_cache, индекс
 * channels_peer_uniq и функция bump_daily_action — в git их не было ни в одной миграции.
 *
 * Подключение — прямой Postgres (SUPABASE_DB_URL), как у прогонятора миграций: каталоги
 * pg_* через Data API не прочитать.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const QUERY_FILE = path.join(__dirname, 'schema-dump.sql')
const OUT_FILE = path.join(__dirname, '..', '..', 'supabase', 'schema.sql')

const CHECK = process.argv.slice(2).includes('--check')

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('Нет SUPABASE_DB_URL. Supabase → Connect → Session pooler → Connection string, положить в .env.')
  console.error('Локально порт 5432 может быть закрыт — тогда снимок пересобирает деплой, а не машина.')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()
let text
try {
  const { rows } = await client.query(fs.readFileSync(QUERY_FILE, 'utf8'))
  text = rows[0]?.schema_text
  if (!text) throw new Error('запрос вернул пусто — проверьте server/scripts/schema-dump.sql')
} finally {
  await client.end()
}

/*
 * Сравниваем БЕЗ возвратов каретки — по той же причине, что и суммы миграций: git на
 * Windows отдаёт CRLF, раннер работает с LF. Иначе `--check` краснел бы на каждом
 * прогоне у половины команды, и на него перестали бы смотреть.
 */
const norm = (s) => String(s).split(String.fromCharCode(13)).join('')

if (CHECK) {
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : ''
  if (norm(current) === norm(text)) {
    console.log('Схема в репозитории совпадает с базой.')
    process.exit(0)
  }
  console.error('⚠  supabase/schema.sql РАСХОДИТСЯ с живой базой.')
  console.error('   Либо схему правили мимо миграций (SQL Editor руками), либо забыли пересобрать снимок.')
  console.error('   Пересобрать: npm run db:schema — и посмотреть в diff, что именно разъехалось.')
  process.exit(2)
}

fs.writeFileSync(OUT_FILE, text, 'utf8')
console.log(`Снимок схемы записан: supabase/schema.sql (${text.split(String.fromCharCode(10)).length} строк)`)
