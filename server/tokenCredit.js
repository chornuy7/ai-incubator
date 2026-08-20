/**
 * MR-150 (Шаг 2, в рамках MR-173): ежемесячное начисление токенов ⚡ по подпискам.
 *
 * Заказчик (20.08): начисляем в день оплаты; оплата на год = 12 начислений в то же число
 * месяца. Реализация: у каждой строки user_subscriptions есть billing_day (день оплаты) и
 * last_credit_month (последний начисленный месяц). Ежедневный крон берёт подписки, у которых
 * СЕГОДНЯ день начисления и этот месяц ещё не начислен (dueForCredit), начисляет сумму
 * monthlyTokens активных модулей на баланс и помечает месяц начисленным (markCredited) —
 * идемпотентно: повторный запуск в тот же день ничего не удваивает.
 *
 * Первый месяц начисляется сразу при оплате (в /api/subscription), крон добирает следующие.
 */
import { dueForCredit, markCredited, creditMonth } from './userSubscriptions.js'
import { effectivePrices } from './priceStore.js'
import { changeCoins } from './balance.js'

/** Общий набор пространства — провижининг админа, не оплата человека: месячные токены не даём. */
const SKIP_USERS = new Set(['__workspace__', '__default'])

/**
 * Начислить всем, кому сегодня положено. Безопасно вызывать многократно (идемпотентно).
 * @param {number} [nowMs]
 * @returns {Promise<{ users:number, coins:number }>}
 */
export async function creditDueTokens(nowMs = Date.now()) {
  const due = await dueForCredit(nowMs)
  if (!due.length) return { users: 0, coins: 0 }
  const { tokensMap } = await effectivePrices()
  const month = creditMonth(nowMs)
  let users = 0
  let coins = 0
  for (const { userId, modules } of due) {
    if (SKIP_USERS.has(userId)) continue
    const tokens = modules.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
    // Даже если сумма 0 (модули без выдачи) — помечаем месяц, чтобы не перебирать их каждый тик.
    if (tokens > 0) {
      await changeCoins(tokens, `Токены подписки (месяц): ${modules.length} модул.`, userId)
      users += 1
      coins += tokens
    }
    await markCredited(userId, modules, month).catch(() => {})
  }
  return { users, coins }
}
