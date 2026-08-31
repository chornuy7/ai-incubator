/**
 * Ежемесячное продление подписки со списанием денег.
 *
 * Решение владельца 28.08: «робимо списання кожного місяця, якщо річна підписка то просто
 * нараховуємо токени. Якщо балансу не вистачає тоді закриваємо доступ».
 *
 * ЧТО БЫЛО. Деньги снимались ровно один раз — в момент покупки, сразу за весь выбранный
 * период. Дальше выставлялся срок, и когда он приходил, доступ закрывался. Автопродления
 * не было: человек с месячной подпиской платил за месяц вперёд и должен был покупать
 * заново руками. Проверка 27.08 (MR-193) это и показала.
 *
 * ЧТО СТАЛО. Раз в месяц, когда оплаченный период кончается, с кошелька списывается
 * месячная стоимость подписки, срок сдвигается вперёд, и тут же начисляются токены за
 * новый месяц. Годовую подписку это не трогает: её срок далеко впереди, списывать нечего —
 * ей достаются только токены, как и раньше.
 *
 * ДЕНЕГ НЕ ХВАТИЛО — не продлеваем и ничего не списываем. Срок остаётся в прошлом, и доступ
 * закрывается сам (`subscriptionExpired`). Человек пополняет счёт — следующий тик продлит.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { effectivePrices } from './priceStore.js'
import { describeModules } from './lib/subscriptionLabel.js'
import { creditMonth } from './tokenCredit.js'
import { appendAudit } from './lib/auditLog.js'

/** Служебные кошельки и общий набор пространства: это провижининг админа, а не оплата. */
const SKIP = new Set(['workspace', '__default', '__workspace__'])

/** Месяц в миллисекундах — тем же счётом, что и при покупке (months * 30 дней). */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Окно продления.
 *
 * ДО срока — сутки: тик ходит раз в шесть часов, и без запаса подписка успела бы
 * протухнуть между тиками.
 *
 * ПОСЛЕ срока — трое суток, и это осознанный предел. Человеку, у которого не хватило денег,
 * даём три дня пополнить счёт: каждый тик пробует снова. Дальше — не пробуем. Иначе
 * подписка, брошенная полгода назад, однажды сама спишет деньги с пополненного кошелька,
 * а человек об этом даже не вспомнит.
 */
export const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000
export const RENEW_AFTER_MS = 3 * 24 * 60 * 60 * 1000

const ms = (v) => (v == null ? null : (typeof v === 'number' ? v : new Date(v).getTime()))

/**
 * Подписки, которым пора продлеваться: оплаченный период кончается (или кончился недавно),
 * и в этом месяце денег ещё не списывали.
 * @returns {Promise<Array<{id:string, userId:string, modules:string[], expiresAt:number}>>}
 */
export async function dueForRenewal(nowMs = Date.now(), onlyUser = '') {
  if (!supabaseEnabled()) return [] // файловый режим (дев/тесты) — деньгами не двигаем
  const db = getSupabase()
  const month = creditMonth(nowMs)

  const { data } = await db.from('subscriptions').select('id, user_id, expires_at, last_charge_month')
  const due = (data || []).filter((r) => {
    // MR-193: см. tokenCredit.js — ускоренный прогон обязан касаться ровно одного
    // человека, иначе он снимет деньги у всех, у кого сегодня подходит срок.
    if (onlyUser && r.id !== onlyUser && r.user_id !== onlyUser) return false
    if (SKIP.has(r.id) || SKIP.has(r.user_id || '')) return false
    // Бессрочная подписка — админский провижининг, продлевать нечего.
    if (!r.expires_at) return false
    // Уже списывали в этом месяце: между списанием и сдвигом срока процесс мог умереть,
    // и без этой проверки следующий тик снял бы деньги второй раз.
    if (r.last_charge_month === month) return false
    const exp = ms(r.expires_at)
    return exp <= nowMs + RENEW_BEFORE_MS && exp >= nowMs - RENEW_AFTER_MS
  })
  if (!due.length) return []

  // Состав — строками user_subscriptions. Одним запросом на всех, а не по подписке.
  const { data: rows } = await db.from('user_subscriptions')
    .select('user_id, module_key')
    .in('user_id', due.map((r) => r.id))
  const byUser = new Map()
  for (const r of rows || []) {
    if (r.module_key === '*') continue // «все модули» — провижининг, а не покупка
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r.module_key)
  }

  const out = []
  for (const r of due) {
    const modules = byUser.get(r.id) || []
    if (!modules.length) continue
    out.push({ id: r.id, userId: r.user_id || r.id, modules, expiresAt: ms(r.expires_at) })
  }
  return out
}

/**
 * Продлить всем, кому пора. Безопасно вызывать многократно.
 *
 * Порядок внутри одной подписки важен: сначала списываем деньги, и только если списание
 * прошло — сдвигаем срок, ставим отметку месяца и начисляем токены. Наоборот было бы хуже:
 * сдвинули срок, а деньги не снялись — человек пользуется бесплатно.
 *
 * @returns {Promise<{ renewed:number, charged:number, tokens:number, unpaid:number }>}
 */
export async function renewDueSubscriptions(nowMs = Date.now(), onlyUser = '') {
  const due = await dueForRenewal(nowMs, onlyUser)
  if (!due.length) return { renewed: 0, charged: 0, tokens: 0, unpaid: 0 }

  const db = getSupabase()
  const { monthMap, tokensMap } = await effectivePrices()
  const { getBalance, changeUsd, changeCoins } = await import('./balance.js')
  // Цену продления считаем ТЕМ ЖЕ кодом, что и цену покупки: subscriptionCost знает про
  // скидку сетапа, про наборы, собранные админом, и про округление до целых. Простая
  // сумма по прайсу этого не знает — и человек, купивший «Парсер + Комментинг» за $20,
  // на продлении получил бы счёт по полному прайсу. Он не менял состав, значит и цена
  // меняться не должна: скидка здесь — свойство НАБОРА, а не разовая акция.
  const { subscriptionCost } = await import('./pricing.js')
  const bundles = await (await import('./bundles.js')).listBundles().catch(() => [])
  const setups = await (await import('./setups.js')).listSetups().catch(() => [])
  const month = creditMonth(nowMs)

  let renewed = 0
  let charged = 0
  let tokens = 0
  let unpaid = 0

  for (const sub of due) {
    const cost = subscriptionCost(sub.modules, bundles, monthMap, {}, setups).sum
    // Набор называем его именем: человек покупал «Всё включено», а не четырнадцать модулей.
    const shown = await describeModules(sub.modules)

    // Подписка без цены (все модули бесплатные) — продлеваем без списания: брать нечего.
    if (cost > 0) {
      const balance = await getBalance(sub.userId).catch(() => null)
      const usd = Number(balance?.usd) || 0
      if (usd < cost) {
        unpaid += 1
        /*
         * Ничего не трогаем: срок остаётся в прошлом, доступ закрывается сам.
         *
         * И оставляем СЛЕД. Раньше здесь была только строка в консоли: она уезжает вместе
         * с логом, и когда человек звонит «почему у меня всё отключилось», подтвердить
         * нечем — списания не было, значит в кошельке пусто, в аудите тоже. Запись в
         * журнале даёт поддержке ответ: когда пробовали, сколько нужно было, сколько было.
         */
        console.warn(`[подписка] ${sub.userId}: не хватает $${(cost - usd).toFixed(2)} на продление (${shown}) — доступ закрывается`)
        await appendAudit({
          action: 'subscription.renew_failed', module: 'billing', initiator: sub.userId,
          reason: `Не хватило денег на продление: нужно $${cost.toFixed(2)}, на счету $${usd.toFixed(2)}`,
          meta: { userId: sub.userId, cost, balance: usd, short: Number((cost - usd).toFixed(2)), modules: sub.modules },
        }).catch(() => {}) // журнал не должен ронять биллинг
        continue
      }
      await changeUsd(-cost, `Продление подписки (месяц): ${shown}`, sub.userId)
      charged += cost
    }

    // Срок считаем от ПРЕЖНЕГО окончания, а не от «сейчас»: иначе каждый тик, пришедший
    // с опозданием, потихоньку съедал бы у человека оплаченные дни.
    const nextExpiry = Math.max(sub.expiresAt, nowMs - RENEW_AFTER_MS) + MONTH_MS
    const iso = new Date(nextExpiry).toISOString()
    await db.from('subscriptions')
      .update({ expires_at: iso, last_charge_month: month, last_credit_month: month, last_credit_at: new Date(nowMs).toISOString(), updated_at: new Date().toISOString() })
      .eq('id', sub.id)
    await db.from('user_subscriptions').update({ expires_at: iso, updated_at: new Date().toISOString() }).eq('user_id', sub.id)

    // Токены за новый месяц начисляем ЗДЕСЬ же, а не ждём тика по billing_day: человек
    // заплатил — он должен получить топливо сразу. Отметку месяца выставили выше, поэтому
    // creditDueTokens этот же месяц второй раз не начислит.
    const monthly = sub.modules.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
    if (monthly > 0) {
      await changeCoins(monthly, `Токены подписки (месяц): ${shown}`, sub.userId, 'grant')
      tokens += monthly
    }
    renewed += 1
  }
  return { renewed, charged, tokens, unpaid }
}
