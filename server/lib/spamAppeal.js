/**
 * Апелляция спамблока через @SpamBot.
 *
 * Флоу бота: /start → он показывает статус. Если ограничение есть и его можно оспорить,
 * под сообщением кнопка («This is a mistake» / «Это ошибка»). Жмём её; бот либо сразу
 * принимает жалобу, либо просит описать проблему — тогда шлём короткий вежливый текст.
 *
 * ⚠️ Апелляция ≠ гарантированное снятие: это ЖАЛОБА модераторам Telegram. Временные/
 * спорные ограничения часто снимаются (иногда сразу, иногда через часы), жёсткий спамблок
 * может не сняться. Мы честно возвращаем финальный ответ бота, а не обещаем результат.
 */
import { Api } from 'telegram/tl/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Ответ бота для лога. Обрыв на полуслове читается как поломка («…seu número salv»),
 * поэтому режем явно и ставим многоточие (правка 27.08).
 */
const cut = (t, n = 400) => { const v = String(t || '').trim(); return v.length > n ? `${v.slice(0, n)}…` : v }

/** Ограничений нет — аккаунт «чист». */
const CLEAN = /no limits|not limited|free as a bird|good news|ограничени\w* (сняты|нет)|свобод|снял/i
/** Аккаунт ограничен. */
const BLOCKED = /is limited|restricted|ограничен|заблокирован|will be able|сможете писать|until/i
/**
 * Кнопки, которые жать НЕЛЬЗЯ: «OK» просто закрывает разговор, «What is spam?» уводит
 * в справку. Раньше при отсутствии подходящей кнопки код жал первую попавшуюся — то есть
 * с равным успехом мог нажать «OK» и посчитать это апелляцией.
 */
const NEVER_PRESS = /^(ok|ок|what is spam\??|что такое спам\??)$/i

/**
 * НАСТОЯЩАЯ проверка «я не робот» — та, которую автоматически проходить нельзя.
 *
 * Отличается она ровно одним: она уводит ИЗ диалога — URL-кнопкой на страницу проверки
 * или картинкой-головоломкой. Пока Telegram такого не присылал, но если пришлёт — здесь
 * работу заканчивает человек, и это не поломка модуля.
 *
 * ⚠️ Слова «Please verify you are a human» сами по себе проверкой НЕ являются. Проверено
 * живьём на боевых аккаунтах 01.09: под этим текстом приходит обычная клавиатура с
 * единственной кнопкой «Done» — ни ссылки, ни картинки, ни головоломки:
 *
 *     текст:    «Please verify you are a human.»
 *     разметка: ReplyKeyboardMarkup
 *       КНОПКА: "Done" · KeyboardButton · data: нет · url: нет
 *
 * Прежний код ловил эти слова регуляркой и останавливался на ПОСЛЕДНЕЙ из четырёх кнопок
 * того же диалога — три предыдущие («This is a mistake», «Yes», «No! Never did that!») он
 * жал сам. То есть блокировал сам себя на пустом месте, а оператору сообщал, что осталось
 * «пройти капчу», которой не существует.
 */
function realCaptcha(msg) {
  const rows = msg?.replyMarkup?.rows || []
  for (const row of rows) for (const b of (row.buttons || [])) {
    // Ссылка наружу — единственный признак, по которому мы останавливаемся.
    if (b?.url) return true
  }
  // Картинка вместо текста в шаге проверки — тоже не наше дело.
  return !!(msg?.media && /verify|human|robot|проверк|робот/i.test(String(msg?.message || '')))
}

/**
 * Кнопка ЗАВЕРШЕНИЯ шага: в сообщении она одна, значит выбора нет и бот ждёт именно её.
 *
 * Правило структурное, а не по словам, — и это важно: @SpamBot отвечает на языке аккаунта.
 * В логах прода 01.09 два аккаунта получили ответ на персидском и португальском, и разбор
 * по английским словам не сработал вовсе. «Одна кнопка» читается одинаково на любом языке.
 */
function loneButton(msg) {
  const rows = msg?.replyMarkup?.rows || []
  const all = []
  for (const row of rows) for (const b of (row.buttons || [])) if (b?.text) all.push(b)
  if (all.length !== 1) return null
  const b = all[0]
  // «OK» закрывает разговор, а не завершает шаг — его жать по-прежнему нельзя.
  if (NEVER_PRESS.test(String(b.text).trim())) return null
  return b
}

/** Бот просит описать проблему словами. */
const ASKS_TEXT = /describe|tell us|напиши|опиши|в двух словах|what happened|расскажи/i
/** Жалоба принята. */
const SUBMITTED = /thank you|thanks|received|submitted|has been sent|переда\w+|принят|рассмотр|спасибо|отправлен/i

/**
 * Кнопка апелляции — приоритетом, а не «первая попавшаяся».
 *
 * ⚠️ @SpamBot шлёт ОБЫЧНУЮ клавиатуру (ReplyKeyboardMarkup, KeyboardButton без `data`),
 * а не инлайн-кнопки. Проверено живьём 22.08: «OK», «What is spam?», «I was wrong, please
 * release me», «This is a mistake» — ни у одной нет `data`. Прежний отбор брал только
 * кнопки с `data`, поэтому не находил НИ ОДНОЙ: модуль честно писал «ограничение
 * осталось», ни разу при этом не пожаловавшись. Жмём такую кнопку отправкой её текста.
 */
function appealButton(msg, text = '') {
  const rows = msg?.replyMarkup?.rows || []
  const all = []
  for (const row of rows) for (const b of (row.buttons || [])) {
    // Кнопку «я не робот» исключаем здесь же: её жать нельзя ни при каком совпадении.
    if (b?.text && !NEVER_PRESS.test(String(b.text).trim())) all.push(b)
  }
  if (!all.length) return null
  const priority = [
    /this is a mistake|это ошибк/i,       // оспорить: ограничение поставили зря
    /i was wrong|release me|прошу снять/i, // признать и попросить снять
    /mistake|ошибк|dispute|не согласен/i,
  ]
  for (const re of priority) {
    const hit = all.find((b) => re.test(b.text || ''))
    if (hit) return hit
  }
  // Второй шаг диалога: бот переспрашивает «Would you like to submit a complaint?» и
  // ждёт Yes/No. Без ответа жалоба НЕ подана — а мы раньше на этом месте останавливались
  // и рапортовали «жалоба подана» (живой прогон 22.08). «Да» жмём только на этот вопрос,
  // а не на любой: соглашаться вслепую с ботом Telegram — плохая идея.
  if (/submit a complaint|подать жалобу|would you like|хотите/i.test(String(text))) {
    const yes = all.find((b) => /^(yes|да)/i.test(String(b.text || '').trim()))
    if (yes) return yes
  }
  /*
   * Третий шаг: бот переспрашивает «рассылали ли вы незапрошенную рекламу? Did you ever
   * do any of this?» с вариантами «No! Never did that!» / «Well… In fact I did.».
   * Отвечаем отрицанием — ровно то же самое модуль и так утверждает текстом апелляции
   * («рассылкой и спамом не занимаюсь»); это заявление ВЛАДЕЛЬЦА аккаунтов модераторам
   * Telegram, а не наша оценка. Кто с этим не согласен — меняет текст апелляции и не
   * пользуется модулем.
   */
  if (/did you ever|have never sent|подтвердите|никогда не/i.test(String(text))) {
    const no = all.find((b) => /^(no|нет|никогда)/i.test(String(b.text || '').trim()))
    if (no) return no
  }
  /*
   * Единственная кнопка в сообщении — это завершение шага, а не выбор. Так выглядит
   * последний экран апелляции: «Please verify you are a human.» + «Done». Жмём её, иначе
   * жалоба остаётся незаконченной и до модераторов не доходит (правка 01.09).
   */
  const одна = loneButton(msg)
  if (одна) return одна
  return null // ничего похожего на апелляцию — вслепую не жмём
}

/** «Нажать» кнопку: инлайн — callback, обычная клавиатура — отправка её текста. */
async function pressButton(client, bot, msg, btn) {
  if (btn.data) {
    await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: msg.id, data: btn.data }))
    return
  }
  await client.sendMessage(bot, { message: String(btn.text) })
}

/**
 * Прогнать апелляцию для ОДНОГО подключённого клиента.
 * @param {import('telegram').TelegramClient} client
 * @param {{ appealText?: string, waitMs?: number }} [opts]
 * @returns {Promise<{state:'clean'|'appealed'|'captcha'|'stalled'|'blocked'|'unknown', text:string, appealed:boolean}>}
 *   captcha — диалог доведён до проверки «я не робот», её завершает человек.
 */
export async function appealSpamblock(client, opts = {}) {
  const appealText = String(opts.appealText || 'Здравствуйте! Я обычный пользователь, пишу только знакомым и по делу. Прошу снять ограничение — рассылкой и спамом не занимаюсь.').slice(0, 500)
  const wait = Number.isFinite(opts.waitMs) ? opts.waitMs : 3000 // пауза на ответ бота (в тестах — короткая)
  try {
    const bot = await client.getEntity('SpamBot')
    await client.sendMessage(bot, { message: '/start' })
    await sleep(wait)

    let msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
    let text = msg?.message || ''
    if (CLEAN.test(text)) return { state: 'clean', text: cut(text), appealed: false }

    let appealed = false
    // Диалог @SpamBot длиннее, чем казалось: «This is a mistake» → «Would you like to
    // submit a complaint?» → «Did you ever do any of this?» → и только потом приём жалобы
    // (замерено живьём 22.08). На трёх шагах мы обрывались на середине. Шесть — с запасом,
    // но не бесконечность: защита от зацикливания остаётся.
    for (let step = 0; step < 6; step++) {
      // Проверку «я не робот» ловим ДО выбора кнопки — хоть текстом, хоть кнопкой. Дальше
      // идти нельзя и не нужно: это последний шаг для человека, а appealButton про капчу
      // не знает и ушёл бы в 'stalled'.
      // Останавливаемся только на НАСТОЯЩЕЙ проверке — той, что уводит из диалога.
      if (realCaptcha(msg)) return { state: 'captcha', text: cut(text), appealed }
      const btn = appealButton(msg, text)
      if (btn && msg?.id) {
        await pressButton(client, bot, msg, btn)
        appealed = true
        await sleep(wait)
        msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
        text = msg?.message || ''
        if (CLEAN.test(text)) return { state: 'clean', text: cut(text), appealed: true }
        if (SUBMITTED.test(text)) return { state: 'appealed', text: cut(text), appealed: true }
        if (realCaptcha(msg)) return { state: 'captcha', text: cut(text), appealed: true }
        continue
      }
      if (ASKS_TEXT.test(text)) {
        await client.sendMessage(bot, { message: appealText })
        appealed = true
        await sleep(wait)
        msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
        text = msg?.message || ''
        if (CLEAN.test(text)) return { state: 'clean', text: cut(text), appealed: true }
        if (SUBMITTED.test(text)) return { state: 'appealed', text: cut(text), appealed: true }
        if (realCaptcha(msg)) return { state: 'captcha', text: cut(text), appealed: true }
        break
      }
      break // ни кнопки, ни просьбы описать — дальше нечего делать
    }

    if (realCaptcha(msg)) return { state: 'captcha', text: cut(text), appealed }
    if (CLEAN.test(text)) return { state: 'clean', text: cut(text), appealed }
    // Мы что-то нажали, но подтверждения от бота не дождались: диалог оборвался на
    // полпути. Раньше здесь возвращалось 'appealed' — и оператор читал «жалоба подана»,
    // хотя бот в этот момент ещё спрашивал «Would you like to submit a complaint?».
    if (appealed) return { state: 'stalled', text: cut(text), appealed: true }
    if (BLOCKED.test(text)) return { state: 'blocked', text: cut(text), appealed: false }
    return { state: 'unknown', text: cut(text), appealed }
  } catch (e) {
    return { state: 'unknown', text: e instanceof Error ? e.message : '', appealed: false }
  }
}

/**
 * Срок ограничения из ответа @SpamBot.
 *
 * Бот называет дату словами и в разных форматах («until Aug 28, 2026, 12:35 UTC»,
 * «до 28.08.2026»). Разбираем консервативно: берём только полную дату и только если она
 * в будущем и не дальше года — иначе вернём null и вызывающий подставит свой срок.
 * Промахнуться с датой хуже, чем её не знать: по ней аккаунт вернётся в работу.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export function parseSpamUntil(text, now = Date.now()) {
  const s = String(text || '')
  let ts = null
  const dotted = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/)
  if (dotted) {
    ts = Date.UTC(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]), Number(dotted[4] || 0), Number(dotted[5] || 0))
  } else {
    const worded = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(?:at\s+)?(\d{1,2}):(\d{2}))?/)
    if (worded) {
      const mi = MONTHS.indexOf(worded[1].slice(0, 3).toLowerCase())
      if (mi >= 0) ts = Date.UTC(Number(worded[3]), mi, Number(worded[2]), Number(worded[4] || 0), Number(worded[5] || 0))
    }
  }
  if (!ts || Number.isNaN(ts)) return null
  if (ts <= now || ts > now + 400 * 86400_000) return null
  return ts
}

/**
 * СПРОСИТЬ у @SpamBot, ограничен ли аккаунт. Только чтение: `/start` и разбор ответа —
 * ни кнопок, ни жалоб (этим занимается `appealSpamblock` и только по команде оператора).
 *
 * Нужна там, где мы раньше ставили спамблок ДОГАДКОЙ. Вывод «чат открыт, личных
 * ограничений нет — значит, дело в аккаунте» верен не всегда: чат может требовать
 * подписку, премиум или время в группе, а платит за ошибку аккаунт — сутки простоя.
 * @SpamBot отвечает от самого Telegram, и он же называет срок.
 *
 * @returns {Promise<{state:'clean'|'blocked'|'unknown', text:string, until:number|null}>}
 */
export async function checkSpamblock(client, opts = {}) {
  const wait = Number.isFinite(opts.waitMs) ? opts.waitMs : 3000
  try {
    const bot = await client.getEntity('SpamBot')
    await client.sendMessage(bot, { message: '/start' })
    await sleep(wait)
    const text = ((await client.getMessages(bot, { limit: 1 }))?.[0]?.message || '').trim()
    if (!text) return { state: 'unknown', text: '', until: null }
    if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 300), until: null }
    if (BLOCKED.test(text)) return { state: 'blocked', text: text.slice(0, 300), until: parseSpamUntil(text) }
    return { state: 'unknown', text: text.slice(0, 300), until: null }
  } catch (e) {
    return { state: 'unknown', text: e instanceof Error ? e.message : '', until: null }
  }
}
