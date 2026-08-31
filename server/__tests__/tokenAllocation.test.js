/**
 * MR-225: владелец ВЫДАЁТ сотруднику токены, а не ставит ему лимит.
 *
 * Заказчик 30.08: «У меня есть пять таких Маш, каждой поставил лимит по 100. Это же 500
 * влезает, а у меня как у владельца может быть всего 100 токенов». Старый «индивидуальный
 * лимит» ничего не выделял: сотрудник тратил из кошелька владельца, а лимит показывался
 * ему как баланс — и сумма лимитов ничем не ограничивалась.
 *
 * Плюс дополнение владельца в чате: «нужно изъять токены добавить возможность».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'mr225-'))
process.env.BALANCE_FILE = path.join(каталог, 'balance.json')
process.env.USERS_FILE = path.join(каталог, 'users.json')
process.env.WALLET_LOG_FILE = path.join(каталог, 'wallet.jsonl')

const { transferCoins, changeCoins, getBalance } = await import('../balance.js')
const { createUser } = await import('../users.js')

const владелец = await createUser({ email: 'owner-mr225@t.io', name: 'Владелец', password: 'secret123' })
const сотрудник = await createUser({ email: 'sub-mr225@t.io', name: 'Маша', password: 'secret123', parentId: владелец.id })

test('выдача уменьшает баланс владельца и появляется у сотрудника', async () => {
  await changeCoins(100, 'тестовое пополнение', владелец.id, 'test')
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: 40 })
  assert.equal(итог.moved, 40)
  assert.equal(итог.ownerLeft, 60, 'у владельца стало меньше ровно на выданное')
  assert.equal(итог.subLeft, 40, 'у сотрудника появилось')
  // Своя запись кошелька у сотрудника появляется только вместе с выдачей: до неё он
  // тратил из кошелька владельца, и начисление вернулось бы владельцу же.
  const { coins } = await getBalance(сотрудник.id)
  assert.equal(coins, 40)
})

test('нельзя выдать больше, чем есть у владельца', async () => {
  await assert.rejects(
    () => transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: 1000 }),
    /выдать 1000 нельзя|У вас/,
    'сумма выданного ограничена остатком владельца — это и была главная беда старой модели',
  )
})

test('изъятие возвращает токены владельцу', async () => {
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: -15 })
  assert.equal(итог.moved, 15)
  assert.equal(итог.subLeft, 25)
  assert.equal(итог.ownerLeft, 75, 'токены вернулись, а не сгорели')
})

test('изымаем больше, чем осталось — забираем остаток и говорим об этом', async () => {
  const итог = await transferCoins({ ownerId: владелец.id, subId: сотрудник.id, amount: -1000 })
  assert.equal(итог.moved, 25, 'забрали ровно остаток')
  assert.equal(итог.subLeft, 0)
  assert.equal(итог.partial, true, 'флаг «забрали не всё, что просили» — чтобы сказать это человеку')
})

test('чужому сотруднику перевести нельзя', async () => {
  const чужой = await createUser({ email: 'alien-mr225@t.io', name: 'Чужой', password: 'secret123' })
  await assert.rejects(
    () => transferCoins({ ownerId: владелец.id, subId: чужой.id, amount: 10 }),
    /не ваш сотрудник/,
  )
  await assert.rejects(() => transferCoins({ ownerId: владелец.id, subId: владелец.id, amount: 10 }), /самому себе/)
})

// ── Витрина: «выдать/изъять» вместо «лимита» ─────────────────────────────────
test('карточка сотрудника показывает выдачу, а не лимит расхода', () => {
  const форма = fs.readFileSync(new URL('../../src/pages/UsersPage.tsx', import.meta.url), 'utf8')
  // Кнопки называют операцию своим именем: это перевод, а не потолок.
  assert.match(форма, /Выдать</)
  assert.match(форма, /Изъять</)
  /*
   * Заголовок строки — просто «Токены сотрудника» (правка по приёмке 31.08): прежний хвост
   * «общий с вашим — токены не выданы» объяснял устройство там, где человек ищет числа.
   */
  assert.match(форма, /Токены сотрудника$/m)
  // «Выдано всего» видно ВСЕГДА, в том числе нулём: строка, которая появляется и исчезает,
  // читается как сломанная. Стоит левее «Потрачено» — так просил владелец.
  const блок = форма.slice(форма.indexOf('У сотрудника:'), форма.indexOf('У вас:'))
  assert.match(блок, /Выдано всего: <b className="text-fg tabular-nums">\{limit\?\.granted \?\? 0\} ⚡<\/b>/)
  assert.ok(блок.indexOf('Выдано всего') < блок.indexOf('Потрачено'), '«выдано» должно стоять левее «потрачено»')
  // Старая кнопка «Задать лимит» ушла с экрана — иначе на нём жили бы две несовместимые
  // модели. Упоминание в комментарии кода не считается: там объясняется, что изменилось.
  assert.doesNotMatch(форма, /className="btn-soft h-8 px-3 text-xs disabled:opacity-40">Задать лимит/)
  // Деньги рядом с токенами — прямая просьба владельца 30.08.
  assert.match(форма, /const деньги = \(t: number\)/)
  // Курс берём из пакетов пополнения, а не выдумываем.
  assert.match(форма, /r\.packs \|\| \[\]/)
})

test('математика действий считается по вводимой сумме, а не по остатку', () => {
  /*
   * Правка по приёмке 31.08: «при выдаче должно сразу указывать математику за 100 токенов,
   * и при вводе мы математику пересчитываем с указанными токенами».
   *
   * Решение принимают ДО нажатия: «сто токенов — это много или мало?» Отвечать на это
   * остатком, который уже у сотрудника, значит отвечать на другой вопрос.
   */
  const форма = fs.readFileSync(new URL('../../src/pages/UsersPage.tsx', import.meta.url), 'utf8')
  assert.match(форма, /const введено = Math\.max\(0, Number\(сумма\) \|\| 0\)/)
  assert.match(форма, /const считаемПо = введено > 0 \? введено : \(свои \?\? 0\)/)
  // Все три строки расчёта идут от одного числа — иначе они разойдутся между собой.
  const блок = форма.slice(форма.indexOf('const действий = считаемПо'), форма.indexOf('const нф ='))
  assert.equal((блок.match(/считаемПо \/ цена\(/g) || []).length, 3)
  // И сказано, о каком числе речь: о вводимой выдаче или об остатке сотрудника.
  assert.match(форма, /столько собираетесь выдать/)
  assert.match(форма, /сейчас у сотрудника/)
})

test('«выдано всего» считается по журналу СОТРУДНИКА, а не владельца', () => {
  /*
   * Баг приёмки 31.08: у сотрудника, которому не выдавали ничего, витрина показала
   * «выдано 200 ⚡». Это были токены подписки ВЛАДЕЛЬЦА: история сотрудника на общем
   * балансе читается по кошельку владельца (своей у него нет), и сумма начислений
   * владельца выдавалась за выданное сотруднику.
   */
  const роуты = fs.readFileSync(new URL('../usersRoutes.js', import.meta.url), 'utf8')
  const место = роуты.slice(роуты.indexOf('const свои = u.balanceMode'), роуты.indexOf('rows.push({'))
  assert.match(место, /walletHistory\(\{ userId: u\.id, limit: 1000, exact: true \}\)/)
  const баланс = fs.readFileSync(new URL('../balance.js', import.meta.url), 'utf8')
  // Обычный режим по-прежнему поднимается к владельцу: своей истории у сотрудника нет.
  assert.match(баланс, /filter\.exact \? filter\.userId : await resolveWalletOwner\(filter\.userId\)/)
})

test('сервер отдаёт витрине собственный остаток сотрудника', () => {
  const роуты = fs.readFileSync(new URL('../usersRoutes.js', import.meta.url), 'utf8')
  assert.match(роуты, /own: свои/, 'в /limits есть свой остаток')
  assert.match(роуты, /granted: выдано/, 'и сколько всего выдано')
  // Старый адрес перевода делегирует общей логике: две арифметики денег однажды разойдутся.
  const старый = роуты.slice(роуты.indexOf("usersRouter.post('/:id/wallet'"), роуты.indexOf("usersRouter.post('/:id/wallet'") + 1200)
  assert.match(старый, /transferCoins/)
  assert.doesNotMatch(старый, /changeCoins\(-move/)
})

test('миграция снимает лимит только у переведённых на свой кошелёк', async () => {
  /*
   * Приёмка 31.08 началась с вопроса «было 500, стало 200 — куда делись 300?». Никуда:
   * 500 были ПОТОЛКОМ расхода чужих денег, 200 — выданные свои. Но старое число остаётся
   * в профиле после перевода и путает.
   *
   * Снимать его можно только там, где оно уже мертво. У сотрудника на ОБЩЕМ кошельке
   * лимит живой и прямо сейчас ограничивает расход баланса владельца: снимешь — откроешь
   * ему весь баланс, обнулишь с переводом — остановишь работу до ручной выдачи. За
   * владельца такое не решают.
   */
  const fs2 = await import('node:fs/promises')
  const sql = await fs2.readFile(new URL('../../supabase/migrations/2026-08-31-mr225-stale-token-limit.sql', import.meta.url), 'utf8')
  const тело = sql.split(/\r?\n/).filter((s) => !s.trim().startsWith('--')).join('\n')

  assert.ok(/update public\.profiles/.test(тело), 'миграция правит профили')
  assert.ok(/set token_limit = null/.test(тело), 'снимается именно лимит')
  assert.ok(/balance_mode = 'individual'/.test(тело), 'только у переведённых на свой кошелёк')
  assert.ok(/parent_id is not null/.test(тело), 'только у сотрудников, не у владельцев')
  assert.ok(!/balance_mode\s*=\s*'individual'\s*,/.test(тело), 'миграция не переводит на свой кошелёк сама')
  assert.ok(!/coin_balance/.test(тело), 'деньги миграция не двигает — это решение владельца')
  assert.ok(!/delete|drop/i.test(тело), 'ничего не удаляем')
})
