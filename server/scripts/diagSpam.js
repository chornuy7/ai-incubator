/** Только ПРОВЕРКА статуса у @SpamBot, без апелляции. node server/scripts/diagSpam.js acc1 acc2 ... */
import { connectAccount, disconnectAccount } from '../lib/accountRunner.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const id of process.argv.slice(2)) {
  let client
  try {
    ;({ client } = await connectAccount(id, null))
    const me = await client.getMe()
    const bot = await client.getEntity('SpamBot')
    await client.sendMessage(bot, { message: '/start' })
    await sleep(4000)
    const msg = (await client.getMessages(bot, { limit: 1 }))?.[0]
    console.log(`\n=== ${id} | ${me.firstName} ===\n${(msg?.message || '(нет ответа)').slice(0, 300)}`)
  } catch (e) {
    console.log(`\n=== ${id} === ОШИБКА: ${e.errorMessage || e.message}`)
  } finally { if (client) await disconnectAccount(client, id) }
}
process.exit(0)
