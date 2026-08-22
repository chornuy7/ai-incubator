/**
 * «Аккаунты вступают, но не пишут» (жалоба владельца 22.08).
 *
 * Разбор показал две разные вещи под одним кодом ошибки USER_BANNED_IN_CHANNEL:
 * запрет от чата и спамблок самого аккаунта. Живой прогон: группа открыта всем
 * (в defaultBannedRights нет sendMessages), аккаунт — обычный участник без личных
 * ограничений, а писать нельзя; @SpamBot на том же аккаунте: «account is limited».
 * Тест сторожит, что мы больше не выдаём догадку за диагноз.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diagnoseWriteBan, sendChannelComment } from '../lib/gramHelpers.js'

const клиент = (participant, chats = []) => ({
  invoke: async () => ({ participant, chats }),
})

test('чат ограничил именно нас — виноват чат', async () => {
  const d = await diagnoseWriteBan(клиент({ className: 'ChannelParticipantBanned' }), { id: 1 })
  assert.equal(d.scope, 'chat')
  assert.match(d.text, /чата/)
})

test('в чате запрещено писать всем — виноват чат', async () => {
  const c = клиент({ className: 'ChannelParticipantSelf' }, [{ id: 1, broadcast: false, defaultBannedRights: { sendMessages: true } }])
  assert.equal((await diagnoseWriteBan(c, { id: 1 })).scope, 'chat')
})

test('чат открыт, личных ограничений нет — значит спамблок аккаунта', async () => {
  const c = клиент({ className: 'ChannelParticipantSelf' }, [{ id: 1, broadcast: false, defaultBannedRights: { changeInfo: true } }])
  const d = await diagnoseWriteBan(c, { id: 1 })
  assert.equal(d.scope, 'account')
  // Оператор должен прочитать не «непонятно что», а что делать дальше.
  assert.match(d.text, /Снятие спамблока/)
})

test('права участника прочитать не удалось — честно говорим «неизвестно», а не гадаем', async () => {
  const c = { invoke: async () => { throw new Error('CHANNEL_PRIVATE') } }
  assert.equal((await diagnoseWriteBan(c, { id: 1 })).scope, 'unknown')
})

/**
 * GetDiscussionMessage возвращает и группу обсуждения, и сам канал, порядок ничем
 * не закреплён. Брали `chats[0]` — на другом порядке комментарий ушёл бы в канал,
 * куда обычному аккаунту писать нельзя.
 */
test('комментарий уходит в группу обсуждения, даже если канал в ответе первым', async () => {
  const группа = { id: 3988403901, broadcast: false }
  const канал = { id: 4340130293, broadcast: true }
  const отправлено = []
  const client = {
    invoke: async (req) => {
      const name = req?.className || req?.constructor?.name || ''
      if (/GetFullChannel/i.test(name)) return { fullChat: {}, chats: [] }
      return { messages: [{ id: 14, peerId: { channelId: 3988403901 } }], chats: [канал, группа] }
    },
    sendMessage: async (peer, opts) => {
      if (opts.commentTo) throw new Error('MSG_ID_INVALID') // вынуждаем запасной путь
      отправлено.push({ peer, opts })
    },
    getEntity: async () => группа,
  }
  await sendChannelComment(client, канал, 5, 'привет')
  assert.equal(отправлено.length, 1)
  assert.equal(отправлено[0].peer.id, группа.id, 'ушло в канал вместо обсуждения')
  assert.equal(отправлено[0].opts.replyTo, 14)
})
