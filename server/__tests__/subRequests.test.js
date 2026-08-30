/**
 * MR-257: сотрудник пишет СВОЕМУ владельцу, а не нашей поддержке.
 *
 * Заказчик 30.08: «в поддержке тебе скажут: свяжитесь с администратором. А нахера мне этот
 * круг?» До этого выбора не было — все обращения шли платформе, и запрос «дай токенов»
 * попадал людям, которые ничего выдать не могут.
 *
 * Механизм один на четыре задачи: MR-204 (запросить токены), MR-247 (переписка с
 * администратором), MR-248 («связаться с администратором» вместо поддержки), MR-249
 * (индикатор непрочитанного) и кусок MR-226 («запросить аккаунт»).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'mr257-'))
process.env.TICKETS_FILE = path.join(каталог, 'tickets.json')

const { createTicket, listTickets, addMessage, unreadFor } = await import('../tickets.js')

test('обращение сотрудника адресовано владельцу и видно ему', async () => {
  const свой = await createTicket({ userId: 'usr_sub', subject: 'Нужны токены', body: 'Дайте 100 ⚡', toOwnerId: 'usr_owner' })
  assert.equal(свой.toOwnerId, 'usr_owner')

  // Владелец видит его в своём списке — по адресату, а не по авторству.
  const уВладельца = await listTickets({ userId: 'usr_owner', ownerId: 'usr_owner' })
  assert.equal(уВладельца.length, 1)
  assert.equal(уВладельца[0].id, свой.id)

  // Посторонний владелец — не видит: это чужое пространство.
  const уЧужого = await listTickets({ userId: 'usr_other', ownerId: 'usr_other' })
  assert.equal(уЧужого.length, 0)
})

test('обращение к платформе адресата не имеет — как было', async () => {
  const кНам = await createTicket({ userId: 'usr_owner', subject: 'Вопрос по оплате', body: 'Не проходит карта' })
  assert.equal(кНам.toOwnerId, null, 'клиент пишет нам, а не самому себе')
  // В списке владельца оно тоже есть — но как ЕГО собственное обращение.
  const свои = await listTickets({ userId: 'usr_owner', ownerId: 'usr_owner' })
  assert.ok(свои.some((t) => t.id === кНам.id))
})

test('непрочитанное считается с той стороны, которой человек в этом обращении является', async () => {
  const t = await createTicket({ userId: 'usr_sub', subject: 'Запрос аккаунта', body: 'Нужен аккаунт', toOwnerId: 'usr_owner' })
  // Для владельца сотрудник — «user», значит его сообщение непрочитано со стороны 'support'.
  assert.equal(unreadFor(t, 'support'), 1, 'владелец видит непрочитанное сообщение сотрудника')
  assert.equal(unreadFor(t, 'user'), 0, 'сам сотрудник своё сообщение прочитанным и оставил')

  await addMessage(t.id, { from: 'support', author: { id: 'usr_owner', name: 'Владелец' }, text: 'Держите' })
  const свежий = (await listTickets({ userId: 'usr_sub' })).find((x) => x.id === t.id)
  assert.equal(unreadFor(свежий, 'user'), 1, 'ответ владельца — непрочитанное для сотрудника')
})

// ── Витрина: четыре места, где сотрудник обращается к владельцу ──────────────
test('у сотрудника есть кнопки запроса вместо тупиков', () => {
  const читать = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

  // MR-204: кошелёк. Раньше на месте убранной покупки было ПУСТО.
  assert.match(читать('src/widgets/AppHeader.tsx'), /Запросить токены у администратора/)
  // MR-226: аккаунты. Сотрудник их не заводит — он их просит.
  assert.match(читать('src/pages/AccountsPage.tsx'), /Запросить аккаунт у администратора/)
  // MR-248: закрытый раздел ведёт к владельцу, а не в поддержку платформы.
  const layout = читать('src/app/Layout.tsx')
  assert.match(layout, /Связаться с администратором/)
  assert.match(layout, /закрыт настройками вашего администратора/)
  // Механика одна на все три места — иначе получилось бы три разных поведения.
  for (const f of ['src/widgets/AppHeader.tsx', 'src/pages/AccountsPage.tsx', 'src/app/Layout.tsx']) {
    assert.match(читать(f), /RequestToOwnerModal/, `${f}: используется общий компонент запроса`)
  }
})

test('непрочитанное подписано словами, а не точкой (MR-249)', () => {
  const w = fs.readFileSync(new URL('../../src/widgets/SupportWidget.tsx', import.meta.url), 'utf8')
  assert.match(w, /пропущенное сообщение/)
  assert.match(w, /пропущенных сообщения/)
  assert.match(w, /пропущенных сообщений/, 'склонение по числу — «5 пропущенных сообщения» читается как ошибка')
  // Подсказку можно закрыть: неубираемая плашка раздражает сильнее точки.
  assert.match(w, /setСкрыто\(true\)/)
  // Счётчик тянется с сервера, а не выдумывается на клиенте.
  assert.match(w, /fetchTicketsUnread/)
})

test('адресата выбирает сервер, а не клиент', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /const toOwnerId = ctx\.user\?\.parentId/, 'родитель берётся из сессии')
  // Иначе можно было бы отправить «запрос» чужому владельцу, подставив его id в теле.
  assert.doesNotMatch(index, /toOwnerId: req\.body/)
})

test('поддержка платформы видит ВСЕ обращения, включая адресованные владельцам', async () => {
  // Решение владельца 31.08: «да в целом мы должны видеть все». Запрос сотрудника уходит
  // его владельцу, но от нас он не прячется: мы читаем всё.
  await createTicket({ userId: 'usr_sub2', subject: 'Дайте аккаунт', body: 'один', toOwnerId: 'usr_owner2' })
  const все = await listTickets({ all: true })
  assert.ok(все.some((t) => t.toOwnerId === 'usr_owner2'), 'адресованное владельцу видно в общем списке')

  // …но в списке оно ПОМЕЧЕНО: отвечать вместо владельца нельзя — токены и аккаунты
  // выдаёт он, и наш ответ пообещал бы то, чего мы не даём.
  const страница = fs.readFileSync(new URL('../../src/pages/SupportPage.tsx', import.meta.url), 'utf8')
  assert.match(страница, /сотрудник → владельцу/)
  assert.match(страница, /isSupportView && t\.toOwnerId/)
})
