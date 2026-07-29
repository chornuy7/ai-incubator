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
/** Бот просит описать проблему словами. */
const ASKS_TEXT = /describe|tell us|напиши|опиши|в двух словах|what happened|расскажи/i
/** Жалоба принята. */
const SUBMITTED = /thank you|thanks|received|переда\w+|принят|рассмотр|спасибо/i

/** Первая callback-кнопка сообщения (для оспаривания), приоритет «это ошибка». */
function firstCallbackButton(msg) {
  const rows = msg?.replyMarkup?.rows || []
  const all = []
  for (const row of rows) for (const b of (row.buttons || [])) if (b?.data) all.push(b)
  if (!all.length) return null
  const prefer = all.find((b) => /mistake|ошибк|dispute|wrong|no|нет|не согласен/i.test(b.text || ''))
  return prefer || all[0]
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
    // Максимум 3 шага диалога с ботом — дальше не крутим (защита от зацикливания).
    for (let step = 0; step < 3; step++) {
      const btn = firstCallbackButton(msg)
      if (btn && msg?.id) {
        await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: msg.id, data: btn.data }))
        appealed = true
        await sleep(wait)
        msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
        text = msg?.message || ''
        if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed: true }
        if (SUBMITTED.test(text)) return { state: 'appealed', text: text.slice(0, 400), appealed: true }
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
        break
      }
      break // ни кнопки, ни просьбы описать — дальше нечего делать
    }

    if (CLEAN.test(text)) return { state: 'clean', text: text.slice(0, 400), appealed }
    if (appealed) return { state: 'appealed', text: text.slice(0, 400), appealed: true }
    if (BLOCKED.test(text)) return { state: 'blocked', text: text.slice(0, 400), appealed: false }
    return { state: 'unknown', text: text.slice(0, 400), appealed }
  } catch (e) {
    return { state: 'unknown', text: e instanceof Error ? e.message : '', appealed: false }
  }
}
