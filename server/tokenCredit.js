/**
 * MR-150 (Шаг 2): ежемесячное начисление токенов ⚡ по подписке.
 *
 * Заказчик (20.08): начисляем в день оплаты; оплата на год = 12 начислений в то же число
 * месяца. Модель подписки — от 21.08: подписка ОДНА и с одной датой на все модули,
 * поэтому день начисления живёт на самой подписке (`subscriptions.billing_day`), а не
 * помодульно. `last_credit_month` ('YYYY-MM') делает крон идемпотентным: повторный запуск
 * в тот же день ничего не удваивает.
 *
 * Первый месяц начисляется сразу при оплате (в /api/subscription), крон добирает следующие.
 * Общий набор пространства (`workspace`) и служебный кошелёк не начисляем: это провижининг
 * админа, а не оплата человека.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { effectivePrices } from './priceStore.js'
import { changeCoins } from './balance.js'

const SKIP = new Set(['workspace', '__default', '__workspace__'])

/** Строка `'YYYY-MM'` (UTC) — формат last_credit_month. */
export function creditMonth(nowMs = Date.now()) {
  const d = new Date(nowMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Подписки, которым СЕГОДНЯ положено начисление: день оплаты совпал с текущим, этот месяц
 * ещё не начислен, подписка не истекла.
 * @returns {Promise<Array<{id:string, userId:string, modules:string[]}>>}
 */
export async function dueForCredit(nowMs = Date.now()) {
  if (!supabaseEnabled()) return [] // файловый режим (дев/тесты) — крон не работает
  const db = getSupabase()
  const today = new Date(nowMs).getUTCDate()
  const month = creditMonth(nowMs)
  const { data } = await db.from('subscriptions')
    .select('id, user_id, modules, expires_at, billing_day, last_credit_month')
    .eq('billing_day', today)
  const out = []
  for (const r of data || []) {
    if (r.last_credit_month === month) continue
    if (SKIP.has(r.id) || SKIP.has(r.user_id || '')) continue
    if (r.expires_at && new Date(r.expires_at).getTime() <= nowMs) continue // подписка истекла
    const modules = Array.isArray(r.modules) ? r.modules : []
    if (!modules.length) continue // 'all' (строкой) — провижининг, не оплата
    out.push({ id: r.id, userId: r.user_id || r.id, modules })
  }
  return out
}

/** Пометить подписку начисленной за месяц (идемпотентность). */
export async function markCredited(id, month) {
  if (!supabaseEnabled()) return
  await getSupabase().from('subscriptions')
    .update({ last_credit_month: month, updated_at: new Date().toISOString() })
    .eq('id', id)
}

/**
 * Начислить всем, кому сегодня положено. Безопасно вызывать многократно.
 * @returns {Promise<{ users:number, coins:number }>}
 */
export async function creditDueTokens(nowMs = Date.now()) {
  const due = await dueForCredit(nowMs)
  if (!due.length) return { users: 0, coins: 0 }
  const { tokensMap } = await effectivePrices()
  const month = creditMonth(nowMs)
  let users = 0
  let coins = 0
  for (const { id, userId, modules } of due) {
    const tokens = modules.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
    if (tokens > 0) {
      await changeCoins(tokens, `Токены подписки (месяц): ${modules.length} модул.`, userId, 'grant')
      users += 1
      coins += tokens
    }
    // Помечаем даже при нулевой сумме — иначе такие подписки перебирались бы каждый тик.
    await markCredited(id, month).catch(() => {})
  }
  return { users, coins }
}
