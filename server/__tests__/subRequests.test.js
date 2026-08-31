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
  assert.match(w, /непрочитанное сообщение/)
  assert.match(w, /непрочитанных сообщения/)
  assert.match(w, /непрочитанных сообщений/, 'склонение по числу — «5 пропущенных сообщения» читается как ошибка')
  /*
   * Плавающей плашки больше нет (заказчик 31.08): она висела поверх поля ввода в
   * переписке. Требование MR-249 при этом в силе — непрочитанное подписано СЛОВАМИ, а не
   * точкой; теперь эти слова стоят строкой внутри карточки, которая открывается по кнопке,
   * и значком на самой кнопке. Закрывать нечего, поэтому проверки на «скрыть» больше нет.
   */
  /*
   * Счётчик по-прежнему приходит С СЕРВЕРА, а не выдумывается на клиенте — но запрос
   * переехал в общий стор: два потребителя со своими таймерами показывали разное
   * (приёмка 31.08, «снизу пропала 1, а в поддержке осталась»).
   */
  assert.match(w, /useUnread\(/)
})

test('владелец может открыть, прочитать и ответить в обращение своего сотрудника', () => {
  /*
   * Баг приёмки 31.08: сотрудник написал владельцу, тот увидел письмо в списке, ответил —
   * и получил «Нет доступа к тикету». Тем же отказом заканчивалась отметка о прочтении,
   * поэтому красный значок не гас даже после чтения.
   *
   * Причина: список адресованные владельцу уже показывал, а проверка на ОТДЕЛЬНОМ
   * обращении осталась прежней — «автор или платформенная поддержка».
   */
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /function можноВТикет\(t, ctx\)/)
  assert.match(index, /return !!\(t\.toOwnerId && String\(t\.toOwnerId\) === String\(ctx\.id\)\)/)
  // Старую проверку не должно остаться ни в одном из трёх мест: открыть, прочитать, ответить.
  assert.doesNotMatch(index, /!ctx\.isSupport && t\.userId !== ctx\.id/)
  // Считаем ВЫЗОВЫ, а не объявление функции: их ровно три — открыть, прочитать, ответить.
  assert.equal((index.match(/!можноВТикет\(t, ctx\)/g) || []).length, 3, 'проверка стоит во всех трёх адресах')
  // Сторона считается по САМОМУ обращению — иначе прочтение снимало бы не тот счётчик.
  assert.match(index, /markRead\(String\(req\.params\.id\), ticketSideFor\(t, ctx, ticketSide\(req, ctx\)\)\)/)
  // Владелец отвечает сотруднику ОТ СЕБЯ: подпись «Поддержка» там читалась бы как ответ
  // из другой организации.
  assert.match(index, /author: asSupport && !адресат \? \{ id: ctx\.id, name: 'Поддержка' \} : ticketAuthor\(ctx\)/)
})

test('сотрудник остаётся сотрудником даже со своим кошельком', () => {
  /*
   * Баг приёмки 31.08: у сотрудника с личным кошельком (MR-225) в панели появились деньги,
   * «Пополнить счёт» и покупка токенов, а кнопка «Запросить токены у администратора»
   * исчезла — вся витрина завязана на флаг isSub с сервера.
   *
   * Признак выводился косвенно: «есть потолок расхода» либо «кошелёк общий с владельцем».
   * Выдача токенов отменила оба: кошелёк стал свой, потолок больше не нужен. Родитель —
   * прямой признак и не зависит от устройства кошелька.
   */
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const ручка = index.slice(index.indexOf("app.get('/api/balance'"), index.indexOf("app.get('/api/balance'") + 3000)
  assert.match(ручка, /const сотрудник = !!профиль\?\.parentId/)
  assert.match(ручка, /if \(сотрудник\) return res\.json\(\{ ok: true, balance: \{ \.\.\.balance, usd: undefined, isSub: true \} \}\)/)
  // Деньги сотруднику не отдаём ни в одной из веток.
  for (const ветка of ручка.split('return res.json').slice(1, 4)) {
    assert.match(ветка, /usd: undefined/, 'в ветке сотрудника доллары не должны уезжать клиенту')
  }
})

test('адресата выбирает сервер, а не клиент', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  /*
   * Проверяем СУТЬ, а не дословную строку: id владельца берётся из сессии, из тела
   * запроса приходит максимум флаг «в поддержку» (сотруднику нужен способ написать и
   * платформе тоже). Прежняя проверка была прибита к тексту выражения и падала от
   * любой правки рядом, ничего при этом не защищая.
   */
  assert.match(index, /toOwnerId = [^\n]*ctx\.user\?\.parentId/, 'родитель берётся из сессии')
  // Иначе можно было бы отправить «запрос» чужому владельцу, подставив его id в теле.
  assert.doesNotMatch(index, /toOwnerId: req\.body/)
  assert.doesNotMatch(index, /toOwnerId = String\(\(req\.body/, 'id адресата из тела запроса — дыра')
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

test('ответ владельца подписан его именем, а не «Поддержка»', async () => {
  /*
   * Приёмка 31.08: сотрудник спросил токены у своего администратора и увидел ответ от
   * «Поддержки». Сервер подписывает такой ответ именем владельца — подпись терялась на
   * отрисовке: чат жёстко писал «Поддержка» любому сообщению отвечающей стороны.
   *
   * Разница именно по адресату: обращение к владельцу подписывает человек, обращение к
   * платформе — роль. Иначе сотрудник читает ответ своего администратора как письмо из
   * другой организации.
   */
  const fs2 = await import('node:fs/promises')
  const src = await fs2.readFile(new URL('../../src/features/support/TicketChat.tsx', import.meta.url), 'utf8')
  const at = src.indexOf('function authorLabel')
  const тело = src.slice(at, src.indexOf('\n}', at))
  assert.ok(/ticket\.toOwnerId/.test(тело), 'подпись должна зависеть от адресата обращения')
  assert.ok(/m\.authorName/.test(тело), 'у обращения к владельцу берём имя автора ответа')
  assert.ok(!/if \(m\.from === 'support'\) return 'Поддержка'/.test(тело),
    'безусловная подпись «Поддержка» стирает имя владельца')
})

test('обращение может закрыть тот, кому оно адресовано', async () => {
  /*
   * Приёмка 31.08: запрос сотрудника висел «в работе» вечно. Проверка стояла одна —
   * «статусы меняет только поддержка», а владелец, которому обращение адресовано, нашей
   * поддержкой не является. Право закрыть — у той же стороны, что отвечает.
   */
  const fs2 = await import('node:fs/promises')
  const src = await fs2.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const at = src.indexOf("app.post('/api/tickets/:id/status'")
  assert.ok(at > 0, 'маршрут смены статуса не найден')
  const тело = src.slice(at, src.indexOf('app.', at + 10))
  assert.ok(/toOwnerId/.test(тело), 'адресат обращения должен иметь право менять статус')
  assert.ok(!/if \(!ctx\.isSupport\) return res\.status\(403\)/.test(тело),
    'проверка «только поддержка» отрезает владельца от его же обращений')

  const стр = await fs2.readFile(new URL('../../src/pages/SupportPage.tsx', import.meta.url), 'utf8')
  assert.ok(/Закрыть обращение/.test(стр), 'в интерфейсе нужна кнопка закрытия')
  assert.ok(/Открыть заново/.test(стр), 'закрытое обращение нужно уметь открыть обратно')
})

test('о переходе токенов узнают обе стороны', async () => {
  /*
   * Приёмка 31.08: владелец выдал сотруднику 200 ⚡, и ни один из них об этом не узнал —
   * колокольчик молчал. Это движение денег в обе стороны: сотруднику важно, что топливо
   * пришло, владельцу — что оно ушло с его баланса.
   */
  const fs2 = await import('node:fs/promises')
  const шапка = await fs2.readFile(new URL('../../src/widgets/AppHeader.tsx', import.meta.url), 'utf8')
  assert.ok(/получено от владельца/i.test(шапка), 'сотруднику нужно уведомление о начислении')
  assert.ok(/выдача токенов сотруднику/i.test(шапка), 'владельцу нужно уведомление о выдаче')

  const баланс = await fs2.readFile(new URL('../balance.js', import.meta.url), 'utf8')
  assert.ok(/Получено от владельца/.test(баланс) && /Выдача токенов сотруднику/.test(баланс),
    'формулировки причин берутся отсюда — уведомления прибиты к ним')
})

test('уведомление о сообщении называет автора, а не «Поддержка»', async () => {
  // Заказчик 31.08: «пусть будет уведомление — сообщение от Модер 1, чтобы он понимал».
  const fs2 = await import('node:fs/promises')
  const шапка = await fs2.readFile(new URL('../../src/widgets/AppHeader.tsx', import.meta.url), 'utf8')
  assert.ok(/Сообщение от \$\{автор\}/.test(шапка), 'у своих обращений в заголовке должен стоять автор')
  assert.ok(/tk\.toOwnerId/.test(шапка), 'подпись выбирается по адресату обращения')
})

test('плавающая плашка непрочитанного убрана из-под поля ввода', async () => {
  /*
   * Приёмка 31.08: плашка висела поверх поля ответа — человек шёл писать и упирался в неё.
   * Непрочитанное остаётся значком на кнопке и строкой внутри раскрытой карточки.
   */
  const fs2 = await import('node:fs/promises')
  const w = await fs2.readFile(new URL('../../src/widgets/SupportWidget.tsx', import.meta.url), 'utf8')
  assert.ok(!/пропущенное сообщение/.test(w), 'плавающая плашка не должна вернуться')
  assert.ok(/непрочитанное сообщение/.test(w), 'внутри карточки строка непрочитанного нужна')
})

test('счётчик непрочитанного один на всё приложение', async () => {
  /*
   * Приёмка 31.08: сотрудник прочитал ответ — значок на кнопке поддержки погас, а в меню
   * «Поддержка 1» осталась. Считали ДВА потребителя своими таймерами: виджет раз в 30
   * секунд, меню раз в 60. До минуты они честно показывали разное.
   *
   * Общий стор, один таймер и пересчёт сразу после прочтения — тот же приём, что у баланса.
   */
  const fs2 = await import('node:fs/promises')
  const меню = await fs2.readFile(new URL('../../src/widgets/AppSidebar.tsx', import.meta.url), 'utf8')
  const виджет = await fs2.readFile(new URL('../../src/widgets/SupportWidget.tsx', import.meta.url), 'utf8')
  const стр = await fs2.readFile(new URL('../../src/pages/SupportPage.tsx', import.meta.url), 'utf8')

  for (const [src, где] of [[меню, 'боковое меню'], [виджет, 'виджет поддержки']]) {
    assert.ok(/useUnread\(/.test(src), `${где}: должно брать счётчик из общего стора`)
    assert.ok(!/fetchTicketsUnread/.test(src), `${где}: свой опрос сервера разводит счётчики`)
    assert.ok(!/setInterval/.test(src), `${где}: свой таймер — это второй источник правды`)
  }
  /*
   * Открыть обращение можно двумя путями: кликом из списка и фоновым перечитыванием уже
   * открытого. Оба отмечают прочитанным на сервере, значит оба обязаны погасить счётчик —
   * проверка «вызов есть где-то» пропускала потерю одного из них.
   */
  const вызовов = (стр.match(/refreshUnread\(\)/g) || []).length
  assert.ok(вызовов >= 2, `счётчик должен гаснуть на ОБОИХ путях открытия, нашлось вызовов: ${вызовов}`)

  const стор = await fs2.readFile(new URL('../../src/features/support/unreadStore.ts', import.meta.url), 'utf8')
  assert.ok(/inflight/.test(стор), 'параллельные вызовы должны склеиваться в один запрос')
  assert.ok(/watchers/.test(стор), 'таймер живёт, пока есть подписчики — иначе опрос на страницах без счётчика')
})

test('поле «сколько нужно» принимает только цифры', async () => {
  // Приёмка 31.08: в поле можно было написать «вфів», и владелец получал запрос без суммы.
  const fs2 = await import('node:fs/promises')
  const src = await fs2.readFile(new URL('../../src/features/requests/RequestToOwner.tsx', import.meta.url), 'utf8')
  assert.ok(/replace\(\/\[\^0-9\]\/g, ''\)/.test(src), 'нецифровое режем на вводе')
  assert.ok(/inputMode="numeric"/.test(src), 'на телефоне нужна цифровая клавиатура')
})

test('плашка непрочитанного не висит поверх поля ответа', async () => {
  /*
   * Она нужна словами (MR-249), но на самой странице обращений закрывала поле ввода —
   * человек шёл писать и упирался в неё. Там она и не нужна: письмо уже перед глазами.
   */
  const fs2 = await import('node:fs/promises')
  const w = await fs2.readFile(new URL('../../src/widgets/SupportWidget.tsx', import.meta.url), 'utf8')
  assert.ok(/непрочитанное сообщение/.test(w), 'индикатор словами остаётся')
  assert.ok(/путь\.startsWith\('\/panel\/support'\)/.test(w), 'на странице обращений плашку не показываем')
})

test('сотрудник может написать и владельцу, и платформе', async () => {
  /*
   * По умолчанию письмо идёт владельцу: доступы, аккаунты и токены выдаёт он, и гонять
   * человека через нашу поддержку — вернуть тот самый круг, от которого уходили. Но
   * платформа тоже ломается, и запирать сотрудника наедине с владельцем нельзя (вопрос
   * заказчика 31.08: «а якщо у мене проблема і потрібно в підтримку написати?»).
   *
   * Выбор ровно из двух адресов. Чужого владельца назвать по-прежнему нельзя: id берётся
   * из родителя, из тела запроса приходит только флаг.
   */
  const fs2 = await import('node:fs/promises')
  const src = await fs2.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const at = src.indexOf("app.post('/api/tickets'")
  const тело = src.slice(at, src.indexOf('app.', at + 10))
  assert.ok(/toSupport === true/.test(тело), 'флаг «в поддержку» должен читаться из запроса')
  assert.ok(/ctx\.user\?\.parentId/.test(тело), 'адресат берётся из родителя, а не из тела')
  assert.ok(!/req\.body[^\n]*toOwnerId/.test(тело), 'id владельца из тела запроса брать нельзя — так пишут чужому')

  const стр = await fs2.readFile(new URL('../../src/pages/SupportPage.tsx', import.meta.url), 'utf8')
  assert.ok(/Моему администратору/.test(стр) && /В поддержку Murmex/.test(стр), 'сотруднику нужен выбор адресата')
  assert.ok(/toSupport: яСотрудник && вПоддержку/.test(стр), 'выбор должен доезжать до сервера')
})
