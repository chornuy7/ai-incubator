/**
 * Live-хук капчи групп (§8.6): после вступления слушаем сообщение бота-антиспама,
 * классифицируем (server/lib/captcha.js) и действуем по стратегии:
 *   auto     — бот сам жмёт кнопку / отвечает простой ответ (действие обычного пользователя);
 *   operator — сложная капча → флаг оператору (лог warning), аккаунт не «сжигаем»;
 *   skip     — не тратим аккаунт: выходим из группы.
 *
 * ⚠️ ToS: собственные проверки Telegram (SMS/reCAPTCHA) классификатор всегда шлёт в 'operator'.
 *
 * Разделение слоёв: detect/plan — чистые (юнит-тест), resolveGroupCaptcha — тонкие GramJS-вызовы.
 */
import { Api } from 'telegram/tl/index.js'
import { classifyCaptcha, CAPTCHA_BOTS } from './captcha.js'

/** Текст кнопок из reply_markup (inline или reply-клавиатура). @returns {{text:string}[]} */
export function extractButtons(msg) {
  const rows = msg?.replyMarkup?.rows || []
  const out = []
  for (const row of rows) for (const b of row?.buttons || []) if (b?.text) out.push({ text: b.text })
  return out
}

/** Привести GramJS-сообщение к простому виду для классификатора. */
export function normalizeMessage(msg) {
  return {
    text: (msg?.message || msg?.text || '').trim(),
    buttons: extractButtons(msg),
    fromBot: (msg?.sender?.username || msg?.sender?.firstName || '').toLowerCase(),
    raw: msg,
  }
}

/** Похоже ли сообщение на капчу: от известного бота ИЛИ капча-ключевые слова (+ кнопки). */
export function looksLikeCaptcha(m) {
  const text = String(m?.text || '').toLowerCase()
  const fromBot = String(m?.fromBot || '').toLowerCase()
  const knownBot = CAPTCHA_BOTS.some((b) => fromBot.includes(b))
  const kw = /(капч|captcha|не бот|not a robot|verify|верифи|подтверд|реши|solv|нажмите|press|human|antispam|антиспам|проверк|докажите)/i.test(text)
  return knownBot || (!!m?.buttons?.length && kw) || kw
}

/** Сообщение от известного капча-бота (высокая уверенность). */
export function isKnownCaptchaBot(fromBot) {
  const f = String(fromBot || '').toLowerCase()
  return CAPTCHA_BOTS.some((b) => f.includes(b))
}

/** Из недавних сообщений выбрать капчу и построить план (чистая). @returns {{message,plan}|null} */
export function planFromMessages(messages) {
  for (const m of messages || []) {
    if (!looksLikeCaptcha(m)) continue
    const plan = classifyCaptcha({ text: m.text, buttons: m.buttons, fromBot: m.fromBot })
    return { message: m, plan }
  }
  return null
}

/** Выйти из группы/канала (skip-стратегия). Дефолт — LeaveChannel; для basic-чата DeleteChatUser. */
async function leaveGroup(client, peer) {
  try {
    await client.invoke(new Api.channels.LeaveChannel({ channel: peer }))
  } catch {
    try {
      const me = await client.getMe()
      await client.invoke(new Api.messages.DeleteChatUser({ chatId: peer.chatId ?? peer.id, userId: me }))
    } catch { /* уже не в группе / нет прав — ничего не делаем */ }
  }
}

/**
 * Live: после вступления обработать капчу группы.
 * @param {import('telegram').TelegramClient} client
 * @param {import('@types/telegram').Entity} peer  группа, в которую вступили
 * @param {{ appendLog?: Function, accountName?: string, limit?: number }} [opts]
 * @returns {Promise<{handled:boolean, action?:string, type?:string, reason?:string}>}
 */
export async function resolveGroupCaptcha(client, peer, opts = {}) {
  const log = (level, msg) => opts.appendLog?.(level, msg, opts.accountName)
  let raw
  try {
    raw = await client.getMessages(peer, { limit: opts.limit ?? 5 })
  } catch {
    return { handled: false }
  }
  const found = planFromMessages((raw || []).map(normalizeMessage))
  if (!found) return { handled: false }

  const { plan, message } = found
  const base = { action: plan.action, type: plan.type, reason: plan.reason }

  if (plan.action === 'operator') {
    log('warning', `Капча требует оператора: ${plan.reason}. Аккаунт ждёт ручного действия.`)
    return { handled: false, ...base }
  }

  if (plan.action === 'skip') {
    // Выходим ТОЛЬКО если сообщение точно от капча-бота: иначе это ложное срабатывание
    // по ключевому слову (напр. пост «проверка связи» в канале) — остаёмся, не бросаем цель.
    if (isKnownCaptchaBot(found.message.fromBot)) {
      await leaveGroup(client, peer)
      log('info', `Капча капча-бота не распознана — вышли из группы (§8.6): ${plan.reason}`)
      return { handled: true, ...base }
    }
    return { handled: false, ...base }
  }

  // action === 'auto'
  try {
    if (plan.solution?.button) {
      // Инлайн-кнопка → click; reply-клавиатура → отправляем текст кнопки.
      if (typeof message.raw?.click === 'function') {
        await message.raw.click({ text: plan.solution.button })
      } else {
        await client.sendMessage(peer, { message: plan.solution.button })
      }
      log('success', `Капча пройдена (кнопка «${plan.solution.button}»): ${plan.reason}`)
    } else if (plan.solution?.reply != null) {
      await client.sendMessage(peer, { message: String(plan.solution.reply) })
      log('success', `Капча пройдена (ответ «${plan.solution.reply}»): ${plan.reason}`)
    }
    return { handled: true, ...base }
  } catch (err) {
    log('warning', `Не удалось пройти капчу авто (${plan.reason}) — нужен оператор: ${err?.message || err}`)
    return { handled: false, ...base }
  }
}
