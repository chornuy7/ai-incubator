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

/*
 * Вывод «спамблок аккаунта» перестал быть догадкой (правка 27.08). Раньше «прав не нашли»
 * автоматически означало вину аккаунта — и он выводился из работы на сутки. Причин
 * молчаливого запрета больше двух: премиум, подписка, время в группе, заявочный режим.
 * Теперь спрашиваем @SpamBot — ответ самого Telegram.
 */
const открытыйЧат = [{ id: 1, broadcast: false, defaultBannedRights: { changeInfo: true } }]
const сБотом = (ответБота) => ({
  invoke: async () => ({ participant: { className: 'ChannelParticipantSelf' }, chats: открытыйЧат }),
  getEntity: async () => ({ id: 42 }),
  sendMessage: async () => {},
  getMessages: async () => [{ message: ответБота }],
})

test('@SpamBot говорит «чист» — виноват чат, аккаунт не выводим', async () => {
  const c = сБотом('Good news, no limits are currently applied to your account.')
  const d = await diagnoseWriteBan(c, { id: 1 }, { waitMs: 0 })
  assert.equal(d.scope, 'chat', 'аккаунт остаётся в работе')
  assert.match(d.text, /@SpamBot/)
})

test('@SpamBot подтверждает ограничение — берём и срок из его ответа', async () => {
  const год = new Date().getUTCFullYear() + 1
  const c = сБотом(`I'm afraid your account is limited until Aug 28, ${год}, 12:35 UTC.`)
  const d = await diagnoseWriteBan(c, { id: 1 }, { waitMs: 0 })
  assert.equal(d.scope, 'account')
  assert.ok(d.until > Date.now(), 'срок настоящий, а не «сутки по типичному»')
  assert.match(d.text, /Снятие спамблока/)
})

test('бот не ответил — говорим «похоже», а не «спамблок подтверждён»', async () => {
  const c = сБотом('')
  const d = await diagnoseWriteBan(c, { id: 1 }, { waitMs: 0 })
  assert.equal(d.scope, 'account', 'осторожность: считаем виноватым аккаунт')
  assert.match(d.text, /Похоже/, 'но не выдаём догадку за подтверждение')
  assert.ok(!d.until, 'срока нет — вызывающий подставит свой')
})

/*
 * Живой разбор 27.08. Владелец дал целью @olfoIa — это «AI INCUBATOR Chat», то есть
 * ГРУППА обсуждения, а не канал. Комментарий уходил в связанный КАНАЛ (4340130293), где
 * обычный участник писать не может, Telegram отвечал USER_BANNED_IN_CHANNEL, а диагноз
 * называл это спамблоком аккаунта: единственный чат в ответе — сам канал, и поиск
 * «чата без broadcast» не находил ничего. Аккаунт «Олечка Bullock» вышел из работы на
 * сутки, задача завершилась, ни одного комментария написано не было.
 */
test('писали в канал — виноват не аккаунт, а выбор цели', async () => {
  const канал = { id: 4340130293, broadcast: true }
  const c = {
    invoke: async () => ({ participant: { className: 'ChannelParticipantSelf' }, chats: [канал] }),
  }
  const d = await diagnoseWriteBan(c, канал, { waitMs: 0 })
  assert.equal(d.scope, 'chat', 'аккаунт остаётся в работе')
  assert.match(d.text, /КАНАЛ/)
  assert.match(d.text, /группу обсуждения/)
})

test('цель — сама группа обсуждения: комментарий уходит в неё, а не в канал', async () => {
  const группа = { id: 3988403901, broadcast: false }
  const отправлено = []
  const client = {
    sendMessage: async (peer, opts) => { отправлено.push({ peer, opts }) },
    invoke: async () => { throw new Error('вступать некуда — мы уже в группе') },
  }
  await sendChannelComment(client, группа, 555, 'привет')
  assert.equal(отправлено.length, 1)
  assert.equal(отправлено[0].peer, группа, 'пишем в группу, а не в связанный канал')
  assert.equal(отправлено[0].opts.replyTo, 555, 'ответом на пост — это и есть комментарий')
  assert.ok(!('commentTo' in отправлено[0].opts), 'commentTo для группы не нужен')
})
