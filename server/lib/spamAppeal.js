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

/** Ограничений нет — аккаунт «чист». */
const CLEAN = /no limits|not limited|free as a bird|good news|ограничени\w* (сняты|нет)|свобод|снял/i
/** Аккаунт ограничен. */
const BLOCKED = /is limited|restricted|ограничен|заблокирован|will be able|сможете писать|until/i
/**
 * Бот просит подтвердить, что ты человек.
 *
 * Последний шаг апелляции (замерено живьём 22.08): «This is a mistake» → «Would you like
 * to submit a complaint?» → «Did you ever do any of this?» → «Please verify you are a
 * human». Это анти-бот проверка Telegram: проходить её автоматически нельзя и не нужно
 * пытаться — здесь работу заканчивает человек. Наше дело — довести диалог до этого места
 * и честно сказать оператору, что осталось.
 */
const CAPTCHA = /verify you are a human|are you a human|not a robot|подтвердите,? что вы человек|не робот/i

/** Бот просит описать проблему словами. */
const ASKS_TEXT = /describe|tell us|напиши|опиши|в двух словах|what happened|расскажи/i
/** Жалоба принята. */
const SUBMITTED = /thank you|thanks|received|submitted|has been sent|переда\w+|принят|рассмотр|спасибо|отправлен/i

/**
 * Кнопки, которые жать НЕЛЬЗЯ: «OK» просто закрывает разговор, «What is spam?» уводит
 * в справку. Раньше при отсутствии подходящей кнопки код жал первую попавшуюся — то есть
 * с равным успехом мог нажать «OK» и посчитать это апелляцией.
 */
const NEVER_PRESS = /^(ok|ок|what is spam\??|что такое спам\??)$/i

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
 * @param {{ appealText?: string }} [opts]
 * @returns {Promise<{state:'clean'|'appealed'|'blocked'|'unknown', text:string, appealed:boolean}>}
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
    if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed: false }

    let appealed = false
    // Диалог @SpamBot длиннее, чем казалось: «This is a mistake» → «Would you like to
    // submit a complaint?» → «Did you ever do any of this?» → и только потом приём жалобы
    // (замерено живьём 22.08). На трёх шагах мы обрывались на середине. Шесть — с запасом,
    // но не бесконечность: защита от зацикливания остаётся.
    for (let step = 0; step < 6; step++) {
      const btn = appealButton(msg, text)
      if (btn && msg?.id) {
        await pressButton(client, bot, msg, btn)
        appealed = true
        await sleep(wait)
        msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
        text = msg?.message || ''
        if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed: true }
        if (SUBMITTED.test(text)) return { state: 'appealed', text: text.slice(0, 400), appealed: true }
        if (CAPTCHA.test(text)) return { state: 'captcha', text: text.slice(0, 400), appealed: true }
        continue
      }
      if (ASKS_TEXT.test(text)) {
        await client.sendMessage(bot, { message: appealText })
        appealed = true
        await sleep(wait)
        msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
        text = msg?.message || ''
        if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed: true }
        if (SUBMITTED.test(text)) return { state: 'appealed', text: text.slice(0, 400), appealed: true }
        if (CAPTCHA.test(text)) return { state: 'captcha', text: text.slice(0, 400), appealed: true }
        break
      }
      break // ни кнопки, ни просьбы описать — дальше нечего делать
    }

    if (CAPTCHA.test(text)) return { state: 'captcha', text: text.slice(0, 400), appealed }
    if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed }
    // Мы что-то нажали, но подтверждения от бота не дождались: диалог оборвался на
    // полпути. Раньше здесь возвращалось 'appealed' — и оператор читал «жалоба подана»,
    // хотя бот в этот момент ещё спрашивал «Would you like to submit a complaint?».
    if (appealed) return { state: 'stalled', text: text.slice(0, 400), appealed: true }
    if (BLOCKED.test(text)) return { state: 'blocked', text: text.slice(0, 400), appealed: false }
    return { state: 'unknown', text: text.slice(0, 400), appealed }
  } catch (e) {
    return { state: 'unknown', text: e instanceof Error ? e.message : '', appealed: false }
  }
}
