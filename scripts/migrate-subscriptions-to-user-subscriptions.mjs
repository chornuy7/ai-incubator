/**
 * MR-173: одноразовый перенос данных subscriptions (JSON) → user_subscriptions (реляционно).
 * Идемпотентно: onConflict(user_id,module_key) ignoreDuplicates — повторный запуск не дублирует.
 * Запуск: node --env-file=.env scripts/migrate-subscriptions-to-user-subscriptions.mjs
 */
import { getSupabase } from '../server/lib/supabase.js'

const db = getSupabase()
const nowMonth = () => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` }

const { data: subs, error } = await db.from('subscriptions').select('id, scope, user_id, modules, expires_at')
if (error) { console.error('read subscriptions ERR:', error.message); process.exit(1) }

const rows = []
for (const s of subs || []) {
  const userId = s.scope === 'workspace' || s.id === 'workspace' ? '__workspace__' : (s.user_id || s.id)
  const m = s.modules
  const mods = m === 'all' || m === '"all"' ? ['*'] : (Array.isArray(m) ? [...new Set(m.filter(Boolean))] : [])
  if (!mods.length) continue
  // billing_day — день месяца из даты истечения (прокси дня оплаты); нет срока → null (не начисляем).
  const billingDay = s.expires_at ? new Date(s.expires_at).getUTCDate() : null
  for (const key of mods) {
    rows.push({
      user_id: userId,
      module_key: key,
      expires_at: s.expires_at || null,
      billing_day: key === '*' ? null : billingDay, // '*' (all) — безлимит, токены не начисляем помесячно
      last_credit_month: nowMonth(), // не начислять ретроактивно за прошлые месяцы
    })
  }
}

console.log(`к вставке строк: ${rows.length} (из ${subs?.length || 0} подписок)`)
if (!rows.length) { console.log('нечего переносить'); process.exit(0) }

const { data: ins, error: e2 } = await db.from('user_subscriptions')
  .upsert(rows, { onConflict: 'user_id,module_key', ignoreDuplicates: true })
  .select('id')
if (e2) { console.error('insert ERR:', e2.message); process.exit(1) }
console.log(`вставлено (новых): ${ins?.length ?? 0}`)

// Контроль: сколько теперь всего
const { count } = await db.from('user_subscriptions').select('id', { count: 'exact', head: true })
console.log(`всего в user_subscriptions: ${count}`)
