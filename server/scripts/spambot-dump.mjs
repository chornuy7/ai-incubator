#!/usr/bin/env node
/**
 * MR-297: снять ДАМП диалога с @SpamBot — что именно приходит на каждом шаге.
 *
 * Зачем. MR-192 научился жать последнюю кнопку «Done», но на проде 02.09 бот в ответ
 * повторяет тот же экран «Please verify you are a human», а подтверждения приёма жалобы мы
 * не видим. Гадать дальше нельзя: первая догадка («единственная кнопка = завершение шага»)
 * уже оказалась верной наполовину. Нужен факт — что приходит после нажатия.
 *
 * Что делает. Идёт по диалогу так же, как боевой модуль, но на каждом шаге печатает
 * СТРУКТУРУ ответа: тип разметки, кнопки с их типами, наличие медиа, автора сообщения. И,
 * в отличие от модуля, читает НЕСКОЛЬКО последних сообщений, а не одно: подозрение как раз
 * в том, что после отправки текста последним в диалоге оказывается НАШЕ сообщение.
 *
 * Запуск (на сервере, где лежат сессии):
 *   node server/scripts/spambot-dump.mjs <accountId>
 *
 * ⚠️ Скрипт НАЖИМАЕТ кнопки — то есть подаёт настоящую жалобу модераторам Telegram.
 * Запускать только по прямому распоряжению и только на аккаунте, который уже в спамблоке.
 */
import 'dotenv/config'
import { loadSessionString, createClient } from '../tgAuth.js'
import { accountFingerprint } from '../lib/deviceFingerprint.js'
import { getAccountMeta } from '../accountsMeta.js'
import { accountProxyUrl } from '../proxies.js'

const accountId = process.argv[2]
if (!accountId) { console.error('Укажите accountId'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ПАУЗА = 5000

/** Кнопки сообщения с их типами — то, по чему модуль и принимает решения. */
function кнопки(msg) {
  const out = []
  for (const row of msg?.replyMarkup?.rows || []) {
    for (const b of row.buttons || []) {
      out.push({
        text: b?.text ?? null,
        класс: b?.className || b?.constructor?.name || '?',
        data: b?.data ? `<${b.data.length} байт>` : null,
        url: b?.url || null,
      })
    }
  }
  return out
}

function печать(метка, msg) {
  console.log('\n────────', метка, '────────')
  if (!msg) return console.log('(сообщения нет)')
  console.log('id:', msg.id, '| исходящее (наше):', !!msg.out, '| дата:', new Date((msg.date || 0) * 1000).toISOString())
  console.log('разметка:', msg.replyMarkup?.className || msg.replyMarkup?.constructor?.name || 'нет')
  console.log('медиа:', msg.media ? (msg.media.className || 'есть') : 'нет')
  console.log('кнопки:', JSON.stringify(кнопки(msg), null, 1))
  console.log('текст:', JSON.stringify(String(msg.message || '').slice(0, 400)))
}

/** Последние сообщения диалога — а не одно: наше собственное может быть последним. */
async function последние(client, bot, n = 4) {
  const msgs = await client.getMessages(bot, { limit: n })
  return msgs || []
}

const meta = await getAccountMeta(accountId).catch(() => ({}))
const session = await loadSessionString(accountId).catch(() => '')
if (!session) { console.error('нет сессии для', accountId); process.exit(1) }

console.log('аккаунт:', accountId, '|', meta?.name || '—', '| статус:', meta?.status)
const client = await createClient(session, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
const bot = await client.getEntity('SpamBot')

await client.sendMessage(bot, { message: '/start' })
await sleep(ПАУЗА)

let шаг = 0
for (; шаг < 6; шаг++) {
  const msgs = await последние(client, bot, 4)
  console.log('\n============ ШАГ', шаг, '· последних сообщений:', msgs.length, '============')
  msgs.forEach((m, i) => печать(`сообщение -${i}`, m))

  // Кнопку выбираем ТАК ЖЕ, как боевой модуль: первая не-запретная в последнем сообщении бота.
  const бот = msgs.find((m) => !m.out)
  const все = кнопки(бот)
  if (!все.length) { console.log('\n>>> кнопок нет — дальше идти некуда'); break }
  const жать = все.find((b) => !/^(ok|ок|what is spam\??|что такое спам\??)$/i.test(String(b.text || '').trim()))
  if (!жать) { console.log('\n>>> все кнопки из запретных — не жмём'); break }

  console.log('\n>>> ЖМЁМ:', JSON.stringify(жать.text), '| через:', жать.data ? 'callback' : 'отправку текста')
  const btn = (бот.replyMarkup?.rows || []).flatMap((r) => r.buttons || []).find((b) => b?.text === жать.text)
  if (btn?.data) {
    const { Api } = await import('telegram')
    await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: bot, msgId: бот.id, data: btn.data }))
  } else {
    await client.sendMessage(bot, { message: String(жать.text) })
  }
  await sleep(ПАУЗА)
}

console.log('\n============ ЧТО В ДИАЛОГЕ ПОСЛЕ ВСЕГО ============')
for (const [i, m] of (await последние(client, bot, 6)).entries()) печать(`сообщение -${i}`, m)

try { await client.disconnect() } catch { /* ignore */ }
console.log('\nготово, шагов пройдено:', шаг)
