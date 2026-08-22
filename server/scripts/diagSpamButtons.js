/** Какие кнопки шлёт @SpamBot: инлайн (можно нажать) или клавиатура (надо ответить текстом). */
import { connectAccount, disconnectAccount } from '../lib/accountRunner.js'
const id = process.argv[2]
const { client } = await connectAccount(id, null)
try {
  const bot = await client.getEntity('SpamBot')
  const msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
  const rm = msg?.replyMarkup
  console.log('разметка:', rm?.className || '(нет разметки)')
  for (const row of (rm?.rows || [])) for (const b of (row.buttons || [])) {
    console.log('  кнопка:', JSON.stringify(b.text), '| класс:', b.className, '| data:', b.data ? 'есть' : 'НЕТ')
  }
} finally { await disconnectAccount(client, id); process.exit(0) }
