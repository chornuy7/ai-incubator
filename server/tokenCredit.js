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
import { cycleMomentIn, billingDayOf } from './lib/billingCycle.js'
import { effectivePrices } from './priceStore.js'
import { describeModules } from './lib/subscriptionLabel.js'
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
export async function dueForCredit(nowMs = Date.now(), onlyUser = '') {
  if (!supabaseEnabled()) return [] // файловый режим (дев/тесты) — крон не работает
  const db = getSupabase()
  const month = creditMonth(nowMs)
  /*
   * Начисление идёт В ДЕНЬ ОФОРМЛЕНИЯ подписки, раз в календарный месяц.
   *
   * Требование владельца одно и то же в обеих формулировках: шкала привязана к дню, когда
   * ЧЕЛОВЕК заплатил. 30.08 он отвергал жёсткое «30-е число месяца» («якщо я платив 14, то
   * нарахування 14-го, а не 30-го»), и тогда обе шкалы перевели на 30 суток. 31.08 он
   * уточнил механику: «раз в місяць і в той день, коли оформлена підписка. Повинно бути 12
   * циклів». Фиксированные 30 суток дают 12 циклов за 360 дней — дата платежа сползает
   * назад на пять дней в год, и раз в шесть лет случается тринадцатое списание.
   *
   * Важно, что шкала здесь ТА ЖЕ, что у денег: иначе за полгода токены и списание разъедутся
   * на неделю, и человек будет платить в одну дату, а топливо получать в другую.
   */
  const { data } = await db.from('subscriptions')
    .select('id, user_id, expires_at, billing_day, last_credit_month, last_credit_at')
  const due = (data || []).filter((r) => {
    // MR-193: прогон «месяц за минуту» идёт на боевой базе, где рядом живые подписки с
    // настоящими деньгами. Фильтр сужает тик до ОДНОГО человека — без него ускоренный
    // прогон списал бы деньги всем подряд. В обычной работе параметр пустой и ничего
    // не меняет.
    if (onlyUser && r.id !== onlyUser && r.user_id !== onlyUser) return false
    // В этом календарном месяце уже начисляли — второй раз не даём. Метка месяца делает
    // крон идемпотентным: он тикает часто, а начисление в месяце одно.
    if (r.last_credit_month === month) return false
    // Число месяца ещё не наступило — рано. День берём с подписки; если его там нет
    // (старые записи), выводим из даты прошлого начисления или из срока.
    const день = r.billing_day
      || (r.last_credit_at ? billingDayOf(new Date(r.last_credit_at).getTime()) : null)
      || (r.expires_at ? billingDayOf(new Date(r.expires_at).getTime()) : 1)
    if (nowMs < cycleMomentIn(nowMs, день)) return false
    if (SKIP.has(r.id) || SKIP.has(r.user_id || '')) return false
    if (r.expires_at && new Date(r.expires_at).getTime() <= nowMs) return false // истекла
    return true
  })
  if (!due.length) return []
  // Состав — из строк user_subscriptions: JSON-колонки `subscriptions.modules` больше нет.
  // Одним запросом на всех, а не по подписке на каждую: их может быть много.
  const { data: rows } = await db.from('user_subscriptions')
    .select('user_id, module_key')
    .in('user_id', due.map((r) => r.id))
  const byUser = new Map()
  for (const r of rows || []) {
    if (r.module_key === '*') continue // «все модули» — админский провижининг, не оплата
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r.module_key)
  }
  const out = []
  for (const r of due) {
    const modules = byUser.get(r.id) || []
    if (!modules.length) continue
    out.push({ id: r.id, userId: r.user_id || r.id, modules })
  }
  return out
}

/** Пометить подписку начисленной за месяц (идемпотентность). */
export async function markCredited(id, month) {
  if (!supabaseEnabled()) return
  await getSupabase().from('subscriptions')
    // Пишем И момент: по нему считается следующее начисление через 30 суток. Строка месяца
    // остаётся для совместимости со старыми подписками, у которых момента ещё нет.
    .update({ last_credit_month: month, last_credit_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
}

/**
 * Начислить всем, кому сегодня положено. Безопасно вызывать многократно.
 * @returns {Promise<{ users:number, coins:number }>}
 */
export async function creditDueTokens(nowMs = Date.now(), onlyUser = '') {
  const due = await dueForCredit(nowMs, onlyUser)
  if (!due.length) return { users: 0, coins: 0 }
  const { tokensMap } = await effectivePrices()
  const month = creditMonth(nowMs)
  let users = 0
  let coins = 0
  for (const { id, userId, modules } of due) {
    const tokens = modules.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
    if (tokens > 0) {
      // В истории должно быть видно, ЗА ЧТО начислено: имя набора, а если это своё
      // сочетание модулей — их перечисление.
      const shown = await describeModules(modules)
      await changeCoins(tokens, `Токены подписки (месяц): ${shown}`, userId, 'grant', modules)
      users += 1
      coins += tokens
    }
    // Помечаем даже при нулевой сумме — иначе такие подписки перебирались бы каждый тик.
    await markCredited(id, month).catch(() => {})
  }
  return { users, coins }
}

/**
 * Сверка ПОДАРОЧНЫХ ⚡ по активным подпискам.
 *
 * Разбор 27.08: у владельца на витрине обещано «500 ⚡ в месяц + 311 ⚡ разово», а на счету
 * 400. Подарки не были начислены НИ ОДНОМУ человеку на платформе — таблица `user_gifts`
 * пустая: выдачу добавили (MR-189) уже после того, как люди купили модули, и разово
 * начисляемое так и осталось обещанием на экране.
 *
 * Одной точки выдачи мало: она срабатывает в момент оплаты, и если в этот момент что-то
 * пошло не так (кода ещё нет, миграция не накатана, запрос упал) — второго шанса не было
 * никогда. Поэтому сверяем ежедневно: `pendingGift` сам считает, что человеку ещё не
 * выдавали, а `markGifted` пишет факт выдачи — повторно тот же модуль не оплатится.
 *
 * Начисляем только по ДЕЙСТВУЮЩЕЙ подписке: подарок идёт за купленный модуль, а не за
 * когда-то бывший.
 *
 * @returns {Promise<{ users:number, coins:number }>}
 */
export async function creditPendingGifts(nowMs = Date.now()) {
  if (!supabaseEnabled()) return { users: 0, coins: 0 }
  const db = getSupabase()
  const { giftMap } = await effectivePrices()
  if (!giftMap || !Object.values(giftMap).some((v) => Number(v) > 0)) return { users: 0, coins: 0 }

  const { data: subs } = await db.from('subscriptions').select('id, user_id, expires_at')
  const живые = (subs || []).filter((r) => {
    if (SKIP.has(r.id) || SKIP.has(r.user_id || '')) return false
    return !r.expires_at || new Date(r.expires_at).getTime() > nowMs
  })
  if (!живые.length) return { users: 0, coins: 0 }

  const { data: rows } = await db.from('user_subscriptions').select('user_id, module_key').in('user_id', живые.map((r) => r.id))
  const byUser = new Map()
  for (const r of rows || []) {
    if (r.module_key === '*') continue // «все модули» — админский провижининг, не покупка
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r.module_key)
  }

  const { pendingGift, markGifted } = await import('./userGifts.js')
  let users = 0
  let coins = 0
  for (const { id, user_id: uid } of живые) {
    const modules = byUser.get(id) || []
    if (!modules.length) continue
    const owner = uid || id
    const gift = await pendingGift(owner, modules, giftMap).catch(() => ({ coins: 0, modules: [] }))
    if (gift.coins <= 0) continue
    const shown = await describeModules(gift.modules)
    await changeCoins(gift.coins, `Подарочные токены (разово): ${shown}`, owner, 'grant', gift.modules)
    await markGifted(owner, gift.modules, giftMap)
    users += 1
    coins += gift.coins
  }
  return { users, coins }
}
