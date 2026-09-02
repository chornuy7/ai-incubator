/**
 * MR-290: перевести пароли прокси из открытого текста в шифрованные.
 *
 * Таблицу `proxies` завела MR-262 и залила данными — 101 строка, и у ВСЕХ пароль лежит
 * колонкой `password` как есть. Пароль прокси не так страшен, как облачный пароль
 * аккаунта, но это чужой платный ресурс: утёкший каталог означает, что через него
 * ходит кто-то ещё, а платим мы.
 *
 *   node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs --dry
 *   node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs
 *
 * Порядок тот же, что у остальных секретов: шифруем → пишем → ЧИТАЕМ ОБРАТНО → сверяем,
 * и только потом стираем открытый текст. Колонку `password` снимет отдельная миграция,
 * когда перенос пройдёт на всех окружениях.
 */
import 'dotenv/config'
import { getSupabase } from '../lib/supabase.js'
import { encryptSecret, decryptSecret, isEncrypted, secretsKeyConfigured, secretsKeyId } from '../lib/secretBox.js'

const DRY = process.argv.slice(2).includes('--dry')

if (!secretsKeyConfigured()) {
  console.error('Нет SECRETS_KEY — шифровать нечем.')
  console.error('Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
  process.exit(1)
}

const db = getSupabase()
if (!db) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY — подключиться не к чему.')
  process.exit(1)
}

const { data: rows, error } = await db.from('proxies').select('id, host, port, password, password_enc')
if (error) {
  console.error('Не удалось прочитать proxies:', error.message)
  process.exit(1)
}

const stats = { всего: rows?.length || 0, сПаролем: 0, перенесено: 0, ужеБыло: 0, ошибок: 0 }
const проблемы = []

for (const r of rows || []) {
  const plain = r.password
  const hasPlain = typeof plain === 'string' && plain !== '' && !isEncrypted(plain)
  const hasEnc = typeof r.password_enc === 'string' && r.password_enc !== ''
  if (!hasPlain && !hasEnc) continue
  stats.сПаролем++
  if (!hasPlain) { stats.ужеБыло++; continue }

  if (DRY) { console.log(`  · ${r.id} (${r.host}:${r.port}) — пароль будет зашифрован`); continue }

  try {
    const enc = encryptSecret(plain)
    const { error: wErr } = await db.from('proxies').update({ password_enc: enc }).eq('id', r.id)
    if (wErr) throw new Error(`запись: ${wErr.message}`)

    const { data: back, error: rErr } = await db.from('proxies').select('password_enc').eq('id', r.id).maybeSingle()
    if (rErr) throw new Error(`чтение: ${rErr.message}`)
    if (decryptSecret(back?.password_enc) !== plain) throw new Error('после расшифровки пароль не совпал')

    const { error: dErr } = await db.from('proxies').update({ password: null }).eq('id', r.id)
    if (dErr) throw new Error(`очистка password: ${dErr.message}`)
    stats.перенесено++
  } catch (e) {
    stats.ошибок++
    проблемы.push(`${r.id} (${r.host}:${r.port}): ${e.message}`)
  }
}

console.log('')
console.log(`Ключ шифрования: ${secretsKeyId()}`)
console.log(`Прокси: ${stats.всего}, из них с паролем: ${stats.сПаролем}`)
if (DRY) {
  console.log('Пробный прогон — ничего не менялось.')
} else {
  console.log(`Перенесено: ${stats.перенесено}, уже было: ${stats.ужеБыло}, ошибок: ${stats.ошибок}`)
  for (const p of проблемы) console.error('  ✗', p)
  if (stats.ошибок) {
    console.error('Открытый текст у этих прокси НЕ удалён — он на месте. Разберитесь и повторите.')
    process.exit(1)
  }
}
