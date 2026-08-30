/**
 * MR-193: прогон «месяц за минуту» для ОДНОГО человека.
 *
 * В задаче написано «временно поменять период с месяца на минуту». Буквально менять период
 * в коде нельзя: прогон идёт на боевой базе, и такой тик пошёл бы по всем подпискам разом,
 * списывая деньги у живых клиентов. Поэтому период не трогаем — двигаем ЧАСЫ, и только для
 * названного пользователя: тик принимает фильтр и физически не видит чужих подписок.
 *
 * Каждый шаг = один «месяц»: сначала продление со списанием денег, следом начисление токенов
 * за новый месяц. Ровно тот путь, который в проде отрабатывает раз в месяц.
 *
 * Запуск:  node scripts/fast-billing.mjs usr_XXXX [шагов] [секунд между шагами]
 */
import 'dotenv/config'
process.env.DATA_BACKEND = 'supabase'

const USER = process.argv[2]
const ШАГОВ = Number(process.argv[3]) || 5
const ПАУЗА = (Number(process.argv[4]) || 60) * 1000

if (!USER || !/^usr_/.test(USER)) {
  console.error('Нужен id пользователя: node scripts/fast-billing.mjs usr_XXXX [шагов] [секунд]')
  console.error('Без него прогон не запускается — иначе тик пойдёт по всем подпискам боевой базы.')
  process.exit(1)
}

const { renewDueSubscriptions } = await import('../server/subscriptionBilling.js')
const { creditDueTokens } = await import('../server/tokenCredit.js')
const { getBalance } = await import('../server/balance.js')
const { getSupabase } = await import('../server/lib/supabase.js')
const db = getSupabase()

const деньги = (n) => '$' + Number(n).toFixed(2)
const пауза = (ms) => new Promise((r) => setTimeout(r, ms))

const sub0 = (await db.from('subscriptions').select('*').eq('id', USER).maybeSingle()).data
if (!sub0) { console.error('Подписки у', USER, 'нет — сначала оформите её в панели.'); process.exit(1) }
const b0 = await getBalance(USER)
console.log(`Пользователь: ${USER}`)
console.log(`Старт: ${деньги(b0.usd)} · ${b0.coins} ⚡ · оплачено до ${String(sub0.expires_at).slice(0, 10)} · день списания ${sub0.billing_day}`)
console.log(`Шагов: ${ШАГОВ}, между шагами ${ПАУЗА / 1000} c. Каждый шаг = один «месяц».\n`)
console.log('шаг │ «дата»      │ деньги            │ токены')
console.log('────┼─────────────┼───────────────────┼──────────────────')

const база = new Date(sub0.expires_at)
let прошлыеД = Number(b0.usd)
let прошлыеТ = Number(b0.coins)

for (let i = 1; i <= ШАГОВ; i++) {
  /*
   * «Сейчас» берём от ФАКТИЧЕСКОЙ даты окончания подписки, а не от календаря.
   *
   * Сначала шаг был календарным месяцем — и на четвёртом шаге тик перестал срабатывать:
   * «месяц» в коде это 30 суток, за три месяца срок отстал от календаря на три дня и вышел
   * за окно продления. В проде такого не будет, там тик ходит каждые шесть часов и ловит
   * срок когда бы тот ни наступил. Здесь воспроизводим именно это: шагаем к сроку.
   */
  const текущая = (await db.from('subscriptions').select('expires_at').eq('id', USER).maybeSingle()).data
  const дата = new Date(new Date(текущая.expires_at).getTime() + 60 * 60 * 1000)
  const now = дата.getTime()

  const р = await renewDueSubscriptions(now, USER)   // деньги + токены за новый месяц
  const н = await creditDueTokens(now, USER)         // досверка: если продление не сработало

  const b = await getBalance(USER)
  const dД = Number((Number(b.usd) - прошлыеД).toFixed(2))
  const dТ = Number(b.coins) - прошлыеТ
  const дельтаД = dД === 0 ? '—' : (dД > 0 ? '+' : '−') + деньги(Math.abs(dД))
  const дельтаТ = dТ === 0 ? '—' : (dТ > 0 ? '+' : '−') + Math.abs(dТ) + ' ⚡'
  console.log(
    String(i).padStart(3) + ' │ ' +
    дата.toISOString().slice(0, 10) + '  │ ' +
    (дельтаД + ' → ' + деньги(b.usd)).padEnd(17) + ' │ ' +
    (дельтаТ + ' → ' + b.coins + ' ⚡') +
    (р.unpaid ? '   ⚠ денег не хватило — доступ закрыт' : ''),
  )
  прошлыеД = Number(b.usd)
  прошлыеТ = Number(b.coins)
  if (р.unpaid) { console.log('\nОстановились: баланс кончился. Это и есть поведение «не хватило — доступ закрывается».'); break }
  if (i < ШАГОВ) await пауза(ПАУЗА)
}

const s = (await db.from('subscriptions').select('expires_at, last_charge_month, last_credit_month').eq('id', USER).maybeSingle()).data
console.log(`\nИтог: оплачено до ${String(s?.expires_at).slice(0, 10)}, последнее списание ${s?.last_charge_month}, последнее начисление ${s?.last_credit_month}`)
