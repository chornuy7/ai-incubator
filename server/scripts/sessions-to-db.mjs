/**
 * MR-290: перенести строки сессий Telegram из файлов в базу, зашифровав их.
 *
 * До этого сессия лежала файлом `server/data/sessions/<accountId>.session` открытым
 * текстом. Сессия — уже пройденная авторизация: ей не нужен ни телефон, ни код, ни
 * облачный пароль. Копия каталога = копия всех аккаунтов.
 *
 *   node --env-file=.env server/scripts/sessions-to-db.mjs --dry     показать, что будет
 *   node --env-file=.env server/scripts/sessions-to-db.mjs           перенести
 *   node --env-file=.env server/scripts/sessions-to-db.mjs --drop    перенести и убрать файлы
 *
 * Порядок на каждой сессии: шифруем → пишем → ЧИТАЕМ ОБРАТНО → сверяем. Файл удаляется
 * только по явному `--drop` и только после успешной сверки. По умолчанию файлы остаются:
 * пока не проверено, что панель работает с базой, второй копии лучше быть.
 *
 * ⚠️ Сессия без аккаунта в `accounts_meta` не переносится: у таблицы внешний ключ на
 * аккаунт. Такие перечисляются отдельно — это либо мусор, либо потерянная мета, и решать
 * это должен человек, а не скрипт.
 */
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getSupabase } from '../lib/supabase.js'
import { encryptSecret, decryptSecret, isEncrypted, secretsKeyConfigured, secretsKeyId } from '../lib/secretBox.js'
import { SESSIONS_DIR } from '../config.js'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const DROP = args.has('--drop')

if (!secretsKeyConfigured()) {
  console.error('Нет SECRETS_KEY — шифровать нечем.')
  console.error('Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
  console.error('⚠️ Ключ нельзя терять: без него сессии не прочитать, аккаунты придётся заводить заново.')
  process.exit(1)
}

const db = getSupabase()
if (!db) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY — подключиться не к чему.')
  process.exit(1)
}

let files = []
try {
  files = (await fs.readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.session'))
} catch {
  console.log(`Каталога ${SESSIONS_DIR} нет — переносить нечего.`)
  process.exit(0)
}

const { data: metaRows, error: metaErr } = await db.from('accounts_meta').select('id')
if (metaErr) { console.error('Не удалось прочитать accounts_meta:', metaErr.message); process.exit(1) }
const known = new Set((metaRows || []).map((r) => r.id))

const { data: haveRows } = await db.from('account_sessions').select('account_id')
const already = new Set((haveRows || []).map((r) => r.account_id))

const stats = { файлов: files.length, перенесено: 0, ужеБыло: 0, безАккаунта: 0, ошибок: 0, файловУдалено: 0 }
const сироты = []
const проблемы = []

for (const f of files) {
  const accountId = f.replace(/\.session$/, '')
  if (already.has(accountId)) { stats.ужеБыло++; continue }
  if (!known.has(accountId)) { stats.безАккаунта++; сироты.push(accountId); continue }

  if (DRY) { console.log(`  · ${accountId} — сессия будет зашифрована и перенесена`); continue }

  try {
    const raw = (await fs.readFile(path.join(SESSIONS_DIR, f), 'utf8')).trim()
    if (!raw) throw new Error('файл пустой')
    // Уже зашифрованный файл (повторный запуск после частичного переноса) не шифруем дважды.
    const plain = isEncrypted(raw) ? decryptSecret(raw) : raw
    const enc = encryptSecret(plain)

    const { error: wErr } = await db.from('account_sessions')
      .upsert({ account_id: accountId, session_enc: enc, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
    if (wErr) throw new Error(`запись: ${wErr.message}`)

    const { data: back, error: rErr } = await db.from('account_sessions').select('session_enc').eq('account_id', accountId).maybeSingle()
    if (rErr) throw new Error(`чтение: ${rErr.message}`)
    if (decryptSecret(back?.session_enc) !== plain) throw new Error('после расшифровки сессия не совпала')

    stats.перенесено++
    if (DROP) { await fs.unlink(path.join(SESSIONS_DIR, f)); stats.файловУдалено++ }
  } catch (e) {
    stats.ошибок++
    проблемы.push(`${accountId}: ${e.message}`)
  }
}

console.log('')
console.log(`Ключ шифрования: ${secretsKeyId()}`)
console.log(`Файлов сессий: ${stats.файлов}`)
if (DRY) {
  console.log(`Уже в базе: ${stats.ужеБыло}, без аккаунта: ${stats.безАккаунта}`)
  console.log('Пробный прогон — ничего не менялось.')
} else {
  console.log(`Перенесено: ${stats.перенесено}, уже было: ${stats.ужеБыло}, ошибок: ${stats.ошибок}`)
  console.log(DROP ? `Файлов удалено: ${stats.файловУдалено}` : 'Файлы оставлены (запустите с --drop, когда убедитесь, что панель работает с базой).')
}
if (сироты.length) {
  console.warn(`\n⚠️ Сессии без аккаунта в accounts_meta (${сироты.length}) — НЕ перенесены:`)
  for (const id of сироты) console.warn('  ·', id)
  console.warn('Это либо мусор, либо потерянная мета. Разберитесь руками: удалять чужой доступ вслепую нельзя.')
}
for (const p of проблемы) console.error('  ✗', p)
if (stats.ошибок) process.exit(1)
