/**
 * Прогон ежемесячного продления подписки со списанием денег (решение владельца 28.08).
 *
 * Проверяет три случая, которые владелец и назвал: месячная подписка списывает деньги
 * каждый месяц; годовая ничего не списывает и получает только токены; денег не хватило —
 * доступ закрывается.
 *
 * Идёт на боевой базе под временными пользователями (префикс usr_renew_probe_): функции
 * продления в файловом режиме сразу возвращают пусто, они работают только с Supabase.
 * В конце всё убирается, чужого скрипт не трогает.
 *
 * Запуск: node scripts/check-renewal.mjs
 */
import 'dotenv/config'
process.env.DATA_BACKEND = 'supabase'

const { renewDueSubscriptions, RENEW_AFTER_MS } = await import('../server/subscriptionBilling.js')
const { effectivePrices } = await import('../server/priceStore.js')
const { getBalance, changeUsd } = await import('../server/balance.js')
const { getSupabase } = await import('../server/lib/supabase.js')
const db = getSupabase()

const МЕС = ['mailing', 'neuro-commenting']
const users = ['usr_renew_probe_m', 'usr_renew_probe_y', 'usr_renew_probe_poor']
const ok = (c, s, extra = '') => { console.log(`${c ? '✅' : '❌'} ${s}${extra ? '  — ' + extra : ''}`); return c }
const день = 24 * 3600_000

async function cleanup() {
  for (const u of users) {
    await db.from('wallet_log').delete().eq('user_id', u)
    await db.from('coin_balance').delete().eq('user_id', u)
    await db.from('user_subscriptions').delete().eq('user_id', u)
    await db.from('subscriptions').delete().eq('id', u)
  }
}
/** Подписка с заданным сроком окончания и деньгами на счету. */
async function создать(u, expiresAt, usd) {
  await db.from('subscriptions').insert({
    id: u, user_id: u, scope: 'user', billing_day: new Date(expiresAt).getUTCDate(),
    expires_at: new Date(expiresAt).toISOString(), updated_at: new Date().toISOString(),
  })
  await db.from('user_subscriptions').insert(МЕС.map((module_key) => ({
    user_id: u, module_key, expires_at: new Date(expiresAt).toISOString(), updated_at: new Date().toISOString(),
  })))
  if (usd > 0) await changeUsd(usd, 'Пополнение (прогон продления)', u)
}
const срок = async (u) => {
  const { data } = await db.from('subscriptions').select('expires_at, last_charge_month').eq('id', u).single()
  return { exp: new Date(data.expires_at).getTime(), month: data.last_charge_month }
}
const деньги = async (u) => Number((await getBalance(u))?.usd) || 0

let провал = false
try {
  await cleanup()
  const { monthMap, tokensMap } = await effectivePrices()
  const цена = МЕС.reduce((s, k) => s + (Number(monthMap?.[k]) || 0), 0)
  const токены = МЕС.reduce((s, k) => s + (Number(tokensMap?.[k]) || 0), 0)
  console.log(`Модули: ${МЕС.join(', ')} — месяц $${цена}, токенов ${токены} ⚡\n`)

  const now = Date.now()

  console.log('— месячная подписка: срок кончается сегодня —')
  await создать('usr_renew_probe_m', now, цена * 3) // денег на три месяца
  const до = await деньги('usr_renew_probe_m')
  const r1 = await renewDueSubscriptions(now)
  провал = !ok(r1.renewed === 1, '1. подписка продлена', `${r1.renewed}`) || провал
  провал = !ok(Math.abs(r1.charged - цена) < 0.01, '2. списана месячная стоимость', `$${r1.charged}`) || провал
  провал = !ok(r1.tokens === токены, '3. токены за новый месяц начислены сразу', `${r1.tokens} ⚡`) || провал
  const после = await деньги('usr_renew_probe_m')
  провал = !ok(Math.abs((до - после) - цена) < 0.01, '4. деньги реально ушли со счёта', `$${до} → $${после}`) || провал
  const s1 = await срок('usr_renew_probe_m')
  провал = !ok(s1.exp > now + 25 * день, '5. срок сдвинут на месяц вперёд', new Date(s1.exp).toISOString().slice(0, 10)) || провал

  const r2 = await renewDueSubscriptions(now + 3600_000)
  провал = !ok(r2.renewed === 0 && r2.charged === 0, '6. повтор в тот же месяц НИЧЕГО не списывает', `$${r2.charged}`) || провал

  console.log('\n— годовая подписка —')
  await создать('usr_renew_probe_y', now + 300 * день, цена * 3)
  const дY = await деньги('usr_renew_probe_y')
  const r3 = await renewDueSubscriptions(now)
  провал = !ok(r3.renewed === 0, '7. годовую не трогаем — её срок далеко', `продлено ${r3.renewed}`) || провал
  провал = !ok((await деньги('usr_renew_probe_y')) === дY, '8. с годовой деньги НЕ списываются', `$${дY}`) || провал

  console.log('\n— денег не хватает —')
  await создать('usr_renew_probe_poor', now, цена / 2) // половина стоимости
  const дP = await деньги('usr_renew_probe_poor')
  const r4 = await renewDueSubscriptions(now)
  провал = !ok(r4.unpaid === 1, '9. подписка помечена как неоплаченная', `${r4.unpaid}`) || провал
  провал = !ok((await деньги('usr_renew_probe_poor')) === дP, '10. деньги НЕ списаны частично', `$${дP}`) || провал
  const sP = await срок('usr_renew_probe_poor')
  провал = !ok(sP.exp <= now, '11. срок НЕ сдвинут — доступ закрывается', new Date(sP.exp).toISOString().slice(0, 10)) || провал

  await changeUsd(цена, 'Пополнение (прогон продления)', 'usr_renew_probe_poor')
  const r5 = await renewDueSubscriptions(now + 2 * 3600_000)
  провал = !ok(r5.renewed === 1, '12. пополнил счёт — следующий тик продлил', `списано $${r5.charged}`) || провал

  console.log('\n— брошенная подписка —')
  await db.from('subscriptions').update({
    expires_at: new Date(now - 60 * день).toISOString(), last_charge_month: null,
  }).eq('id', 'usr_renew_probe_y')
  await changeUsd(цена * 2, 'Пополнение (прогон продления)', 'usr_renew_probe_y')
  const дA = await деньги('usr_renew_probe_y')
  const r6 = await renewDueSubscriptions(now)
  провал = !ok(r6.renewed === 0, '13. подписку, брошенную давно, сами не воскрешаем', `продлено ${r6.renewed}`) || провал
  провал = !ok((await деньги('usr_renew_probe_y')) === дA, '14. и денег с неё не берём', `$${дA}`) || провал
  console.log(`   (окно продления — ${RENEW_AFTER_MS / день} суток после срока: три дня пополнить и всё)`)
} catch (e) {
  провал = true
  console.log('❌ упало:', e.message)
} finally {
  await cleanup()
  const { data } = await db.from('subscriptions').select('id').in('id', users)
  const { data: w } = await db.from('wallet_log').select('id').in('user_id', users)
  console.log(`\n🧹 убрано: подписок ${data?.length ?? '?'}, записей журнала ${w?.length ?? '?'}`)
}
process.exit(провал ? 1 : 0)
