/**
 * §11.3: наполнить `profiles` из нашей таблицы `users`, сопоставив по e-mail.
 *
 * Запускать ПОСЛЕ того, как люди заведены в Supabase Auth (Authentication → Users).
 * До этого в auth.users никого нет, сопоставлять не с кем — скрипт честно скажет об этом
 * и ничего не тронет.
 *
 * Что делает:
 *   • берёт auth.users (через service-key, admin API);
 *   • для каждого нашего юзера ищет auth-запись с тем же e-mail;
 *   • создаёт profiles: id = auth uuid, legacy_id = наш usr_…, плюс имя, активность, тип;
 *   • подчинение (parent_id) проставляет ВТОРЫМ проходом — родитель мог ещё не существовать
 *     на момент вставки ребёнка.
 *
 * Идемпотентно: повторный запуск обновляет те же строки, дублей не создаёт.
 * Ничего не удаляет и не переключает вход — это делает отдельный шаг по рунбуку.
 *
 * Запуск: node --env-file=.env scripts/fill-profiles.mjs
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE
if (!url || !key) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY в окружении')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

// Всё в функции: `process.exit` посреди работы обрывает открытые хендлы клиента,
// и Windows дописывает в вывод assert-шум, который читается как ошибка скрипта.
async function main() {
// ── 1. Кто заведён в Supabase Auth ───────────────────────────────────────────
const { data: authList, error: authErr } = await db.auth.admin.listUsers({ perPage: 1000 })
if (authErr) {
  console.error('Не удалось прочитать auth.users:', authErr.message)
  return 1
}
const authUsers = authList?.users || []
if (!authUsers.length) {
  console.log('В Supabase Auth пока нет пользователей.')
  console.log('Заведите их: Supabase → Authentication → Users → Add user, затем запустите скрипт снова.')
  return 0
}
const authByEmail = new Map(authUsers.map((u) => [String(u.email || '').toLowerCase(), u.id]))
console.log(`В auth.users: ${authUsers.length}`)

// ── 2. Наши пользователи ─────────────────────────────────────────────────────
const { data: users, error: usersErr } = await db.from('users').select('id, email, name, active, parent_id, user_type_id')
if (usersErr) { console.error('Не удалось прочитать users:', usersErr.message); return 1 }

const rows = []
const unmatched = []
for (const u of users || []) {
  const authId = authByEmail.get(String(u.email || '').toLowerCase())
  // Без пары в auth профиль создать нельзя: profiles.id ссылается на auth.users(id).
  if (!authId) { unmatched.push(u.email); continue }
  rows.push({
    id: authId,
    legacy_id: u.id,
    name: u.name || '',
    active: u.active !== false,
    user_type_id: u.user_type_id ?? null,
  })
}

if (!rows.length) {
  console.log('Ни один наш пользователь не совпал по e-mail с auth.users.')
  console.log('Не совпали:', unmatched.join(', ') || '(нет)')
  return 0
}

const { error: upErr } = await db.from('profiles').upsert(rows, { onConflict: 'id' })
if (upErr) { console.error('Ошибка записи profiles:', upErr.message); return 1 }
console.log(`profiles: ${rows.length}`)
if (unmatched.length) console.log('Без пары в auth (профиль не создан):', unmatched.join(', '))

// ── 3. Подчинение вторым проходом ────────────────────────────────────────────
// parent_id ссылается на profiles(id), поэтому проставляем, когда все строки уже есть.
const legacyToNew = new Map(rows.map((r) => [r.legacy_id, r.id]))
let linked = 0
for (const u of users || []) {
  if (!u.parent_id) continue
  const childId = legacyToNew.get(u.id)
  const parentId = legacyToNew.get(u.parent_id)
  if (!childId || !parentId) continue
  const { error } = await db.from('profiles').update({ parent_id: parentId }).eq('id', childId)
  if (!error) linked += 1
}
console.log(`подчинение проставлено: ${linked}`)
console.log('Готово. Вход по-прежнему идёт через таблицу users — переключение делается отдельно (см. docs/RUNBOOK-auth-profiles.md).')
  return 0
}

process.exitCode = await main()
