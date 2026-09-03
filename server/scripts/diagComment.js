/**
 * Диагностика «аккаунт вступил, но не пишет».
 * node server/scripts/diagComment.js <accountId> [channelUsername]
 *
 * Отвечает на два вопроса разом:
 *   1) ограничен ли САМ аккаунт (спамблок) — me.restricted / restrictionReason;
 *   2) в какой пир целится наш код — chats[0] из GetDiscussionMessage может быть
 *      КАНАЛОМ, а не группой обсуждения.
 */
import { Api } from 'telegram'
import { connectAccount, disconnectAccount } from '../lib/accountRunner.js'

const accountId = process.argv[2]
const uname = process.argv[3] || 'ai_incubator_test'
if (!accountId) { console.error('нужен accountId'); process.exit(1) }

const short = (c) => ({
  id: `${c.id}`, title: c.title, username: c.username,
  broadcast: !!c.broadcast, megagroup: !!c.megagroup, left: !!c.left,
  bannedRights: c.bannedRights ? Object.keys(c.bannedRights).filter((k) => c.bannedRights[k] === true) : null,
  defaultBanned: c.defaultBannedRights ? Object.keys(c.defaultBannedRights).filter((k) => c.defaultBannedRights[k] === true) : null,
})

const { client } = await connectAccount(accountId, null)
try {
  const me = await client.getMe()
  console.log('АККАУНТ:', me.firstName, me.phone || '', '| restricted =', !!me.restricted, '| reason =', JSON.stringify(me.restrictionReason || null))

  const channel = await client.getEntity(uname)
  console.log('КАНАЛ:', JSON.stringify(short(channel)))

  const full = await client.invoke(new Api.channels.GetFullChannel({ channel }))
  console.log('linkedChatId =', `${full.fullChat?.linkedChatId}`)

  const posts = await client.getMessages(channel, { limit: 1 })
  const postId = posts[0]?.id
  console.log('последний пост =', postId)

  const d = await client.invoke(new Api.messages.GetDiscussionMessage({ peer: channel, msgId: postId }))
  const msg = d.messages?.[0]
  console.log('msg.id в обсуждении =', msg?.id, '| msg.peerId =', JSON.stringify(msg?.peerId))
  console.log('chats из ответа (ПОРЯДОК ВАЖЕН):')
  ;(d.chats || []).forEach((c, i) => console.log(`  [${i}]`, JSON.stringify(short(c))))

  const chosenNow = d.chats?.[0]
  console.log('\nКОД СЕЙЧАС берёт chats[0] →', chosenNow?.title, '| broadcast =', !!chosenNow?.broadcast)

  const want = `${msg?.peerId?.channelId ?? msg?.peerId?.chatId ?? ''}`
  const correct = (d.chats || []).find((c) => `${c.id}` === want)
  console.log('ПРАВИЛЬНЫЙ пир (по msg.peerId) →', correct?.title, '| broadcast =', !!correct?.broadcast)

  // Реальная проверка прав в группе обсуждения
  if (correct) {
    try {
      const p = await client.invoke(new Api.channels.GetParticipant({ channel: correct, participant: 'me' }))
      console.log('участник обсуждения:', p.participant?.className, JSON.stringify(p.participant?.bannedRights || null))
    } catch (e) { console.log('GetParticipant ошибка:', e.errorMessage || e.message) }
  }

  // Живая отправка в ПРАВИЛЬНЫЙ пир
  const target = correct || msg?.peerId
  try {
    await client.sendMessage(target, { message: `проверка связи ${new Date().toLocaleTimeString('ru-RU')}`, replyTo: msg.id })
    console.log('\n✅ ОТПРАВКА В ГРУППУ ОБСУЖДЕНИЯ ПРОШЛА')
  } catch (e) { console.log('\n❌ отправка в обсуждение:', e.errorMessage || e.message) }

  // Живая отправка тем способом, что пробует код первым
  try {
    await client.sendMessage(channel, { message: `проверка commentTo ${new Date().toLocaleTimeString('ru-RU')}`, commentTo: postId })
    console.log('✅ commentTo прошёл')
  } catch (e) { console.log('❌ commentTo:', e.errorMessage || e.message) }
} finally {
  await disconnectAccount(client, accountId)
  process.exit(0)
}
