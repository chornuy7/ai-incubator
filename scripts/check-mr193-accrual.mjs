/**
 * MR-193: прогон месячного начисления токенов и разового подарка.
 *
 * Владелец просил поменять период с месяца на минуту и посмотреть, как капает. Менять
 * код для этого не нужно: и `creditDueTokens`, и `creditPendingGifts` принимают время
 * ПАРАМЕТРОМ. Подставляя даты, мы проигрываем хоть год за секунду — и, в отличие от
 * «минуты вместо месяца», проверяем ровно те даты, на которых логика и ломается: тот же
 * месяц (не должно задвоиться) и следующий (должно начислиться снова).
 *
 * Прогон идёт на БОЕВОЙ базе, потому что обе функции в файловом режиме сразу возвращают
 * пусто — они работают только с Supabase. Поэтому здесь временный пользователь со своим
 * префиксом, а в конце всё убирается. Ничего чужого скрипт не трогает.
 *
 * Запуск: node scripts/check-mr193-accrual.mjs
 */
import 'dotenv/config'
process.env.DATA_BACKEND = 'supabase'

const { creditDueTokens, creditPendingGifts, creditMonth } = await import('../server/tokenCredit.js')
const { effectivePrices } = await import('../server/priceStore.js')
const { getSupabase } = await import('../server/lib/supabase.js')
const db = getSupabase()

const U = 'usr_mr193_probe'
/**
 * Набор модулей берём ИЗ ПРАЙСА целиком — это сценарий из задачи дословно: «подписка на
 * 14 модулей», 14 × 100 = 1400 ⚡ в месяц и 311 ⚡ разового подарка. Раньше здесь стояли
 * два модуля: суммы сходились, но числа из тикета в выводе не появлялись, и сверить
 * прогон с задачей глазами было нельзя.
 */
const { effectivePrices: _prices } = await import('../server/priceStore.js')
const MODULES = Object.keys((await _prices()).tokensMap || {})
const ok = (c, s, extra = '') => { console.log(`${c ? '✅' : '❌'} ${s}${extra ? '  — ' + extra : ''}`); return c }

/** Начисления этого пользователя из журнала кошелька. */
async function ledger() {
  const { data } = await db.from('wallet_log').select('amount, reason, currency, kind').eq('user_id', U)
  return data || []
}
const coinsOf = (rows) => rows.filter((r) => r.currency !== 'usd').reduce((s, r) => s + Number(r.amount), 0)

async function cleanup() {
  await db.from('user_gifts').delete().eq('user_id', U)
  await db.from('wallet_log').delete().eq('user_id', U)
  await db.from('coin_balance').delete().eq('user_id', U)
  await db.from('user_subscriptions').delete().eq('user_id', U)
  await db.from('subscriptions').delete().eq('id', U)
}

let провал = false
try {
  await cleanup() // на случай, если прошлый прогон оборвался

  const { tokensMap, giftMap } = await effectivePrices()
  const ждёмМесячных = MODULES.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
  const ждёмПодарок = MODULES.reduce((s, k) => s + (Number(giftMap?.[k]) || 0), 0)
  console.log(`Модули: ${MODULES.join(', ')}`)
  console.log(`По прайсу: месячных ${ждёмМесячных} ⚡, подарочных ${ждёмПодарок} ⚡\n`)

  // Подписка «оплачена» 15-го числа, действует год. Даты ниже — 15-е разных месяцев.
  const день = 15
  const мес = (m) => Date.UTC(2026, m, день, 12, 0, 0)
  const янв = мес(0), фев = мес(1)

  await db.from('subscriptions').insert({
    id: U, user_id: U, scope: 'user', billing_day: день,
    expires_at: new Date(Date.UTC(2027, 0, 15)).toISOString(),
    updated_at: new Date().toISOString(),
  })
  await db.from('user_subscriptions').insert(MODULES.map((module_key) => ({
    user_id: U, module_key, expires_at: new Date(Date.UTC(2027, 0, 15)).toISOString(), updated_at: new Date().toISOString(),
  })))
  console.log('— месячное начисление —')

  const r1 = await creditDueTokens(янв)
  провал = !ok(r1.coins === ждёмМесячных, '1. в день оплаты начислены месячные токены', `${r1.coins} ⚡`) || провал

  const r2 = await creditDueTokens(янв + 3 * 3600_000)
  провал = !ok(r2.coins === 0, '2. повтор в тот же месяц НИЧЕГО не добавляет', `${r2.coins} ⚡`) || провал

  const r3 = await creditDueTokens(фев)
  провал = !ok(r3.coins === ждёмМесячных, '3. в следующем месяце начислено снова', `${r3.coins} ⚡`) || провал

  const r4 = await creditDueTokens(мес(1) + 24 * 3600_000)
  провал = !ok(r4.coins === 0, '4. не в свой день ничего не начисляется', `${r4.coins} ⚡`) || провал

  const после = await ledger()
  провал = !ok(coinsOf(после) === ждёмМесячных * 2, '5. в журнале ровно два начисления', `${coinsOf(после)} ⚡ за ${после.length} записи`) || провал
  провал = !ok(после.every((r) => r.currency !== 'usd'), '6. ТИК НЕ СПИСЫВАЕТ ДЕНЬГИ — только токены',
    после.map((r) => r.currency).join(', ')) || провал
  провал = !ok(после.every((r) => /Токены подписки \(месяц\)/.test(r.reason || '')), '7. в истории видно, за что начислено',
    JSON.stringify(после[0]?.reason)) || провал

  console.log('\n— разовый подарок —')
  const g1 = await creditPendingGifts(янв)
  провал = !ok(g1.coins === ждёмПодарок, '8. подарок начислен', `${g1.coins} ⚡`) || провал

  const g2 = await creditPendingGifts(фев)
  провал = !ok(g2.coins === 0, '9. в следующем месяце подарок НЕ повторяется', `${g2.coins} ⚡`) || провал

  const g3 = await creditPendingGifts(мес(6))
  провал = !ok(g3.coins === 0, '10. и через полгода тоже не повторяется', `${g3.coins} ⚡`) || провал

  const { data: gifts } = await db.from('user_gifts').select('module_key').eq('user_id', U)
  /*
   * Запись о выдаче должна появиться у тех модулей, у которых подарок ЕСТЬ, и не должна —
   * у остальных. Раньше здесь сравнивалось со ВСЕМ набором модулей: на двух модулях, где
   * подарок был у обоих, это сходилось, а на полной подписке из 14 — нет, потому что
   * дарить нечего у двенадцати. Проверка была написана под частный случай.
   */
  const сПодарком = MODULES.filter((k) => Number(giftMap?.[k]) > 0).sort()
  const записано = (gifts || []).map((g) => g.module_key).sort()
  провал = !ok(записано.join() === сПодарком.join(),
    '11. выдача записана по модулям С подарком — и только по ним',
    `записано: ${записано.join(', ') || '—'} · с подарком в прайсе: ${сПодарком.join(', ')}`) || провал

  console.log('\n— досверка после сбоя (находка Ильи 27.08) —')
  await db.from('user_gifts').delete().eq('user_id', U) // как будто выдача не сработала
  const g4 = await creditPendingGifts(мес(3))
  провал = !ok(g4.coins === ждёмПодарок, '12. потерянный подарок досверка выдаёт', `${g4.coins} ⚡`) || провал
  const g5 = await creditPendingGifts(мес(4))
  провал = !ok(g5.coins === 0, '13. и снова только один раз', `${g5.coins} ⚡`) || провал

  console.log('\n— истёкшая подписка —')
  await db.from('subscriptions').update({ expires_at: new Date(Date.UTC(2026, 0, 10)).toISOString() }).eq('id', U)
  const r5 = await creditDueTokens(мес(5))
  провал = !ok(r5.coins === 0, '14. по истёкшей подписке начислений нет', `${r5.coins} ⚡`) || провал
  const g6 = await creditPendingGifts(мес(5))
  провал = !ok(g6.coins === 0, '15. и подарка по истёкшей тоже нет', `${g6.coins} ⚡`) || провал

  const итог = await ledger()
  console.log(`\nВсего начислено за прогон: ${coinsOf(итог)} ⚡ (${ждёмМесячных * 2} месячных + ${ждёмПодарок * 2} подарочных)`)
  console.log(`Месяц метки последнего начисления: ${creditMonth(фев)}`)
} catch (e) {
  провал = true
  console.log('❌ упало:', e.message)
} finally {
  await cleanup()
  const { data: left } = await db.from('wallet_log').select('id').eq('user_id', U)
  const { data: leftSub } = await db.from('subscriptions').select('id').eq('id', U)
  console.log(`\n🧹 убрано: записей журнала ${left?.length ?? '?'}, подписок ${leftSub?.length ?? '?'}`)
}
process.exit(провал ? 1 : 0)
