/**
 * MR-290: перевести облачные пароли аккаунтов из открытого текста в шифрованные.
 *
 * До этого пароль (2FA) лежал в `accounts_meta.data.twoFA` как есть — у 47 аккаунтов из
 * 63. Миграция завела колонку `two_fa_enc`, но перенести данные она не может: перенос
 * требует ключа, а ключу в SQL не место. Это делает здесь.
 *
 *   node --env-file=.env server/scripts/encrypt-secrets.mjs --dry   показать, что будет
 *   node --env-file=.env server/scripts/encrypt-secrets.mjs         перенести
 *
 * ПОРЯДОК ДЕЙСТВИЙ НА КАЖДОМ АККАУНТЕ — шифруем, ЧИТАЕМ ОБРАТНО, СВЕРЯЕМ, и только потом
 * убираем открытый текст. Наоборот делать нельзя: если ключ окажется не тот или запись
 * не дойдёт, пароль будет потерян безвозвратно — в Telegram облачный пароль не прочитать,
 * а архивы импорта у оператора вряд ли сохранились.
 *
 * Скрипт идемпотентен: уже перенесённые аккаунты пропускаются, повторный запуск безопасен.
 */
import 'dotenv/config'
import { getSupabase } from '../lib/supabase.js'
import { encryptSecret, decryptSecret, isEncrypted, secretsKeyConfigured, secretsKeyId } from '../lib/secretBox.js'

const DRY = process.argv.slice(2).includes('--dry')

if (!secretsKeyConfigured()) {
  console.error('Нет SECRETS_KEY — шифровать нечем.')
  console.error('Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
  console.error('⚠️ Этот ключ нельзя терять: без него пароли не восстановить. Держите копию вне сервера.')
  process.exit(1)
}

const db = getSupabase()
if (!db) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY — подключиться не к чему.')
  process.exit(1)
}

const { data: rows, error } = await db.from('accounts_meta').select('id, data, two_fa_enc')
if (error) {
  console.error('Не удалось прочитать accounts_meta:', error.message)
  process.exit(1)
}

const stats = { всего: rows?.length || 0, сПаролем: 0, перенесено: 0, ужеБыло: 0, ошибок: 0 }
const проблемы = []

for (const r of rows || []) {
  const plain = r.data?.twoFA
  const hasPlain = typeof plain === 'string' && plain !== '' && !isEncrypted(plain)
  const hasEnc = typeof r.two_fa_enc === 'string' && r.two_fa_enc !== ''
  if (!hasPlain && !hasEnc) continue
  stats.сПаролем++

  if (!hasPlain) { stats.ужеБыло++; continue }

  if (DRY) {
    console.log(`  · ${r.id} — пароль будет зашифрован${hasEnc ? ' (колонка уже занята — сверю)' : ''}`)
    continue
  }

  try {
    const enc = encryptSecret(plain)
    // 1. Записываем шифротекст, открытый текст пока НЕ трогаем.
    const { error: wErr } = await db.from('accounts_meta').update({ two_fa_enc: enc }).eq('id', r.id)
    if (wErr) throw new Error(`запись: ${wErr.message}`)

    // 2. Читаем ОБРАТНО ИЗ БАЗЫ и сверяем. Проверять то, что лежит в памяти, смысла нет:
    //    вопрос именно в том, доехало ли значение целым.
    const { data: back, error: rErr } = await db.from('accounts_meta').select('two_fa_enc').eq('id', r.id).maybeSingle()
    if (rErr) throw new Error(`чтение: ${rErr.message}`)
    if (decryptSecret(back?.two_fa_enc) !== plain) throw new Error('после расшифровки пароль не совпал')

    // 3. Только теперь убираем открытый текст из jsonb.
    const { twoFA: _gone, ...cleanData } = r.data || {}
    const { error: dErr } = await db.from('accounts_meta').update({ data: cleanData }).eq('id', r.id)
    if (dErr) throw new Error(`очистка data: ${dErr.message}`)

    stats.перенесено++
  } catch (e) {
    stats.ошибок++
    проблемы.push(`${r.id}: ${e.message}`)
  }
}

console.log('')
console.log(`Ключ шифрования: ${secretsKeyId()}`)
console.log(`Аккаунтов: ${stats.всего}, из них с паролем: ${stats.сПаролем}`)
if (DRY) {
  console.log('Пробный прогон — ничего не менялось. Запустите без --dry, чтобы перенести.')
} else {
  console.log(`Перенесено: ${stats.перенесено}, уже было зашифровано: ${stats.ужеБыло}, ошибок: ${stats.ошибок}`)
  for (const p of проблемы) console.error('  ✗', p)
  if (stats.ошибок) {
    console.error('Открытый текст у этих аккаунтов НЕ удалён — он на месте. Разберитесь и повторите.')
    process.exit(1)
  }
}
