/**
 * Разовый перенос состава подписок из JSON-колонки в строки user_subscriptions.
 *
 * Читает subscriptions.modules (массив или строка 'all') и раскладывает по строкам.
 * Дата берётся с самой подписки — одна на все строки пользователя (модель «одна
 * подписка, модули докупаются внутрь»). 'all' кладём меткой '*': это «все модули,
 * включая будущие», разворачивать её в перечень нельзя — новый модуль перестал бы
 * выдаваться автоматически.
 *
 * Идемпотентен: повторный запуск ничего не задваивает (unique + on conflict).
 * Ничего не удаляет: старая колонка остаётся, откат возможен.
 *
 *   node --env-file=.env scripts/migrate-subscriptions-to-rows.mjs          # показать план
 *   node --env-file=.env scripts/migrate-subscriptions-to-rows.mjs --apply  # выполнить
 */
import { getSupabase, supabaseEnabled } from '../server/lib/supabase.js'

const APPLY = process.argv.includes('--apply')
if (!supabaseEnabled()) { console.error('Нужна база: задайте SUPABASE_URL и ключ.'); process.exit(1) }
const db = getSupabase()

const { data: subs, error } = await db.from('subscriptions').select('id, modules, expires_at')
if (error) { console.error('Не прочитать subscriptions:', error.message); process.exit(1) }

let rows = 0
let skipped = 0
const plan = []
for (const s of subs || []) {
  const keys = s.modules === 'all' ? ['*'] : (Array.isArray(s.modules) ? [...new Set(s.modules.filter(Boolean))] : [])
  if (!keys.length) { skipped += 1; continue }
  plan.push({ id: s.id, keys, expires_at: s.expires_at || null })
  rows += keys.length
}

console.log(`Подписок: ${subs?.length ?? 0} · переносим: ${plan.length} · строк будет: ${rows} · пропущено (пустой состав): ${skipped}`)
for (const p of plan.slice(0, 8)) {
  console.log(`  ${p.id.padEnd(20)} ${p.keys.length === 1 && p.keys[0] === '*' ? 'все модули (*)' : p.keys.length + ' модул.'} · до ${p.expires_at ? String(p.expires_at).slice(0, 10) : 'без срока'}`)
}
if (plan.length > 8) console.log(`  … ещё ${plan.length - 8}`)

if (!APPLY) { console.log('\nЭто ПЛАН. Запустите с --apply, чтобы выполнить.'); process.exit(0) }

const now = new Date().toISOString()
let written = 0
for (const p of plan) {
  const { error: e } = await db.from('user_subscriptions').upsert(
    p.keys.map((module_key) => ({ user_id: p.id, module_key, expires_at: p.expires_at, updated_at: now })),
    { onConflict: 'user_id,module_key' },
  )
  if (e) { console.error(`  ${p.id}: ${e.message}`); continue }
  written += p.keys.length
}
console.log(`\nЗаписано строк: ${written}`)

// Сверка: состав из строк должен совпасть с составом из колонки — иначе перенос не полный.
let bad = 0
for (const p of plan) {
  const { data } = await db.from('user_subscriptions').select('module_key').eq('user_id', p.id)
  const got = (data || []).map((r) => r.module_key).sort().join(',')
  if (got !== p.keys.slice().sort().join(',')) { console.error(`  РАСХОЖДЕНИЕ у ${p.id}: строки «${got}»`); bad += 1 }
}
console.log(bad ? `Расхождений: ${bad}` : 'Сверка пройдена: состав в строках совпадает с колонкой у всех подписок.')
