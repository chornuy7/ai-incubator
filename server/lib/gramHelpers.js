import { Api } from 'telegram/tl/index.js'
import { mapTelegramError } from './protection.js'

/** @param {string} raw */
export function extractInviteHash(raw) {
  const trimmed = raw.trim()
  let m = trimmed.match(/(?:https?:\/\/)?t\.me\/\+([A-Za-z0-9_-]+)/i)
  if (m) return m[1]
  m = trimmed.match(/(?:https?:\/\/)?t\.me\/joinchat\/([A-Za-z0-9_-]+)/i)
  if (m) return m[1]
  return null
}

/** @param {string} raw */
export function normalizeTargetLabel(raw) {
  const hash = extractInviteHash(raw)
  if (hash) return `invite:+${hash.slice(0, 8)}…`
  return raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '') || raw
}

/** @param {unknown} err */
function errMsg(err) {
  return `${/** @type {{ errorMessage?: string, message?: string }} */ (err).errorMessage || /** @type {{ message?: string }} */ (err).message || ''}`
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} peer */
async function isChannelMember(client, peer) {
  if (!peer) return false
  try {
    await client.invoke(new Api.channels.GetParticipant({
      channel: peer,
      participant: new Api.InputPeerSelf(),
    }))
    return true
  } catch (err) {
    const msg = errMsg(err)
    if (msg.includes('USER_NOT_PARTICIPANT')) return false
    if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE')) {
      try {
        await client.getMessages(peer, { limit: 1 })
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

/** @param {import('telegram').TelegramClient} client @param {string} hash */
async function joinByInviteHash(client, hash) {
  try {
    const checked = await client.invoke(new Api.messages.CheckChatInvite({ hash }))
    if (checked.className === 'ChatInviteAlready') {
      return { peer: checked.chat, status: 'already_member' }
    }
    if (checked.className === 'ChatInvite' && checked.requestNeeded) {
      try {
        const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash }))
        const peer = imported.chats?.[0] ?? imported.updates?.chats?.[0]
        if (peer) return { peer, status: 'request_sent' }
      } catch (err) {
        if (errMsg(err).includes('INVITE_REQUEST_SENT')) {
          return { peer: null, status: 'request_sent' }
        }
        throw err
      }
    }
    const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash }))
    const peer = imported.chats?.[0] ?? imported.updates?.chats?.[0]
    if (!peer) throw new Error('INVITE_IMPORT_FAILED')
    return { peer, status: 'joined' }
  } catch (err) {
    const msg = errMsg(err)
    if (msg.includes('USER_ALREADY_PARTICIPANT')) {
      return { peer: await client.getEntity(`https://t.me/+${hash}`), status: 'already_member' }
    }
    if (msg.includes('INVITE_REQUEST_SENT')) {
      return { peer: null, status: 'request_sent' }
    }
    throw err
  }
}

/**
 * Вступить в канал/супергруппу если ещё не участник.
 * @returns {{ joined: boolean, status: 'joined'|'already_member'|'not_needed' }}
 */
export async function joinPeerIfNeeded(client, peer) {
  if (!peer) return { joined: false, status: 'not_needed' }
  if (await isChannelMember(client, peer)) {
    return { joined: false, status: 'already_member' }
  }
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: peer }))
    return { joined: true, status: 'joined' }
  } catch (err) {
    const msg = errMsg(err)
    if (msg.includes('USER_ALREADY_PARTICIPANT') || msg.includes('CHANNELS_TOO_MUCH')) {
      return { joined: false, status: 'already_member' }
    }
    if (msg.includes('INVITE_REQUEST_SENT')) {
      return { joined: false, status: 'request_sent' }
    }
    throw err
  }
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} channel */
export async function joinDiscussionGroupIfNeeded(client, channel) {
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel }))
    const linkedId = full.fullChat?.linkedChatId
    if (!linkedId) return null
    let linked = full.chats?.find((c) => c.id?.value === linkedId.value || `${c.id}` === `${linkedId}`)
    if (!linked) {
      try {
        linked = await client.getEntity(linkedId)
      } catch {
        return null
      }
    }
    /*
     * Если по ссылке лежит КАНАЛ, значит мы уже стоим в группе обсуждения и вступать
     * некуда (разбор 27.08). У группы `linkedChatId` указывает НА канал — обратная
     * сторона той же связи. Раньше мы этого не различали и радостно вступали в канал,
     * записывая в лог «Уже в группе обсуждения»; комментарий потом уходил в канал, куда
     * обычный участник писать не может, и аккаунт получал за это спамблок ни за что.
     */
    if (linked?.broadcast) return null
    const r = await joinPeerIfNeeded(client, linked)
    return { peer: linked, ...r }
  } catch {
    return null
  }
}

/**
 * Проверить членство без вступления (для пропуска задержки join).
 * @returns {{ peer: import('@types/telegram').Entity | null, status: string, label: string }}
 */
export async function peekMembership(client, raw) {
  const trimmed = raw.trim()
  const label = normalizeTargetLabel(trimmed)
  const hash = extractInviteHash(trimmed)

  if (hash) {
    try {
      const checked = await client.invoke(new Api.messages.CheckChatInvite({ hash }))
      if (checked.className === 'ChatInviteAlready') {
        return { peer: checked.chat, status: 'already_member', label }
      }
      return { peer: null, status: 'need_join', label }
    } catch {
      return { peer: null, status: 'need_join', label }
    }
  }

  const username = trimmed.replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split(/[/?#]/)[0].trim()
  if (!username) throw new Error('INVALID_TARGET')
  const peer = await client.getEntity(username)
  const member = await isChannelMember(client, peer)
  return { peer, status: member ? 'already_member' : 'need_join', label: `@${username}` }
}

/** @returns {{ peer: import('@types/telegram').Entity | null, status: string, label: string }} */
export async function ensureJoined(client, raw) {
  const trimmed = raw.trim()
  const label = normalizeTargetLabel(trimmed)
  const hash = extractInviteHash(trimmed)

  if (hash) {
    const inv = await joinByInviteHash(client, hash)
    return { peer: inv.peer, status: inv.status, label }
  }

  const username = trimmed.replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split(/[/?#]/)[0].trim()
  if (!username) throw new Error('INVALID_TARGET')

  const peer = await client.getEntity(username)
  const join = await joinPeerIfNeeded(client, peer)
  return { peer, status: join.status, label: `@${username}` }
}

/** @param {import('telegram').TelegramClient} client @param {string} raw @deprecated use ensureJoined */
export async function resolvePeer(client, raw) {
  const r = await ensureJoined(client, raw)
  if (r.status === 'request_sent' && !r.peer) {
    const err = new Error('INVITE_REQUEST_SENT')
    /** @type {{ errorMessage?: string }} */ (err).errorMessage = 'INVITE_REQUEST_SENT'
    throw err
  }
  if (!r.peer) throw new Error('NOT_A_MEMBER')
  return r.peer
}

/** @param {{ status: string, label: string }} membership */
export function membershipLogMessage(membership) {
  switch (membership.status) {
    case 'joined': return `Вступил в ${membership.label}`
    case 'already_member': return `Уже участник: ${membership.label}`
    case 'request_sent': return `Заявка на вступление отправлена (${membership.label}) — ждём одобрения админа`
    default: return `Статус ${membership.label}: ${membership.status}`
  }
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} channel @param {number} limit */
export async function fetchPosts(client, channel, limit = 15) {
  const messages = await client.getMessages(channel, { limit })
  return messages.filter((m) => m?.id && !m.action && (m.message?.trim() || m.media))
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} channel @param {number} postId @param {string} text */
export async function sendChannelComment(client, channel, postId, text) {
  /*
   * Цель может быть САМОЙ группой обсуждения, а не каналом (разбор 27.08: владелец дал
   * @olfoIa — это «AI INCUBATOR Chat», группа, а не канал). Тогда комментарий — это
   * обычный ответ на пост В ЭТОЙ ЖЕ группе: ни искать обсуждение, ни звать `commentTo`
   * не нужно. Прежний путь уводил отправку в связанный канал и падал там с
   * USER_BANNED_IN_CHANNEL — писать в канал обычный участник и не должен.
   */
  if (channel?.broadcast === false) {
    try {
      await client.sendMessage(channel, { message: text, replyTo: postId })
      return
    } catch (e) {
      e.writePeer = channel
      throw e
    }
  }
  const linked = await joinDiscussionGroupIfNeeded(client, channel)
  try {
    await client.sendMessage(channel, { message: text, commentTo: postId })
    return
  } catch (first) {
    // Запрет на отправку падает одинаково в оба способа (проверено 22.08 живым прогоном:
    // и `commentTo`, и прямая отправка в обсуждение дали USER_BANNED_IN_CHANNEL). Второй
    // заход ничего не изменит — только лишний RPC с уже проблемного аккаунта.
    if (/USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN/i.test(`${first?.errorMessage || first?.message || ''}`)) {
      // Кому именно писали — нужно вызывающему, чтобы отличить запрет чата от спамблока.
      first.writePeer = linked?.peer || null
      throw first
    }
  }
  const discussion = await client.invoke(new Api.messages.GetDiscussionMessage({ peer: channel, msgId: postId }))
  const msg = discussion.messages?.[0]
  if (!msg) throw new Error('NO_DISCUSSION')
  // Берём чат, В КОТОРОМ лежит сообщение обсуждения, а не первый попавшийся из ответа:
  // Telegram возвращает здесь и группу, и сам канал, и порядок ничем не закреплён.
  const want = `${msg.peerId?.channelId ?? msg.peerId?.chatId ?? ''}`
  const peer = (discussion.chats || []).find((c) => `${c.id}` === want)
    || (discussion.chats || []).find((c) => !c.broadcast)
    || msg.peerId
  if (peer) await joinPeerIfNeeded(client, peer)
  try {
    await client.sendMessage(peer, { message: text, replyTo: msg.id })
  } catch (e) {
    e.writePeer = peer
    throw e
  }
}

/**
 * Кто виноват в запрете на отправку — АККАУНТ или ЧАТ.
 *
 * До 22.08 мы отвечали на этот вопрос догадкой: USER_BANNED_IN_CHANNEL расшифровывали как
 * «запрет в конкретном чате, аккаунт жив». Живая проверка показала обратное — группа была
 * открыта на запись всем (в defaultBannedRights нет sendMessages), аккаунт числился в ней
 * обычным участником без личных ограничений, и всё равно получал этот код; @SpamBot на том
 * же аккаунте отвечал «account is limited». То есть Telegram шлёт этот код и при СПАМБЛОКЕ
 * аккаунта. Разница принципиальная: в одном случае надо менять чат, в другом — снимать
 * спамблок, и пока мы путали их, оператор чинил не то.
 *
 * Отличаем правами участника: если чат ограничил именно нас — это видно в
 * ChannelParticipantBanned/bannedRights; если ограничений нет, а писать нельзя — похоже
 * на ограничение аккаунта.
 *
 * «Похоже» — не приговор (правка 27.08). По одному только «прав не нашли» мы выводили
 * аккаунт из работы на СУТКИ, а причин молчаливого запрета больше двух: чат может
 * требовать премиум, подписку на канал, время в группе или держать заявочный режим.
 * Поэтому вывод об АККАУНТЕ теперь подтверждаем у @SpamBot — это ответ самого Telegram,
 * и он же называет срок. Говорит «чист» — виноват чат, аккаунт не трогаем.
 *
 * @returns {Promise<{scope:'account'|'chat'|'unknown', text:string, until?:number|null}>}
 */
export async function diagnoseWriteBan(client, peer, opts = {}) {
  if (!peer) return { scope: 'unknown', text: 'Telegram запретил отправку — причину определить не удалось' }
  try {
    const res = await client.invoke(new Api.channels.GetParticipant({ channel: peer, participant: 'me' }))
    const part = res.participant
    if (part?.className === 'ChannelParticipantBanned' || part?.bannedRights?.sendMessages === true) {
      return { scope: 'chat', text: 'Запрет от админов чата: этому аккаунту здесь писать нельзя (аккаунт цел)' }
    }
    /*
     * Писали в КАНАЛ, а не в чат (разбор 27.08). В канал обычный участник не пишет
     * никогда — Telegram отвечает на это тем же USER_BANNED_IN_CHANNEL. Прав участника
     * при этом нет никаких (`ChannelParticipantSelf` без bannedRights), а поиск чата ниже
     * ничего не находит, потому что единственный чат в ответе — сам канал. Раньше отсюда
     * следовал вывод «значит, спамблок аккаунта», и живой аккаунт выводился из работы на
     * сутки за чужую ошибку в настройке цели.
     */
    const самЧат = res.chats?.find((c) => `${c.id}` === `${peer?.id ?? ''}`)
    const каналЛи = самЧат?.broadcast ?? peer?.broadcast
    const админ = part?.className === 'ChannelParticipantCreator' || !!part?.adminRights
    if (каналЛи && !админ) {
      return {
        scope: 'chat',
        text: 'Писали в КАНАЛ, а туда обычный участник и не может — комментарий должен уходить в группу обсуждения.'
          + ' Аккаунт цел: проверьте, включены ли у канала комментарии, и укажите целью сам канал, а не его чат',
      }
    }
    const chat = res.chats?.find((c) => !c.broadcast)
    if (chat?.defaultBannedRights?.sendMessages === true) {
      return { scope: 'chat', text: 'В этом чате запрещено писать всем участникам — комментарии закрыты' }
    }
  } catch {
    return { scope: 'unknown', text: 'Telegram запретил отправку — права участника прочитать не удалось' }
  }
  const { checkSpamblock } = await import('./spamAppeal.js')
  const бот = await checkSpamblock(client, opts) // opts.waitMs — пауза на ответ бота (в тестах короткая)
  if (бот.state === 'clean') {
    return {
      scope: 'chat',
      text: 'Писать не даёт ЧАТ, а не спамблок: @SpamBot подтвердил, что ограничений на аккаунте нет.'
        + ' Скорее всего чат требует премиум, подписку или время в группе. Аккаунт продолжает работать.',
    }
  }
  if (бот.state === 'blocked') {
    return {
      scope: 'account',
      until: бот.until || null,
      text: `Спамблок аккаунта подтверждён @SpamBot${бот.until ? ` (до ${new Date(бот.until).toLocaleString('ru-RU')})` : ''}:`
        + ` «${бот.text}». Лечится модулем «Снятие спамблока»`,
    }
  }
  return {
    scope: 'account',
    text: 'Похоже на спамблок аккаунта: чат открыт на запись, личных ограничений в нём нет, а писать не даёт.'
      + ' Подтвердить у @SpamBot не вышло — проверьте модулем «Снятие спамблока»',
  }
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} peer @param {number} msgId @param {string} emoji */
export async function sendReaction(client, peer, msgId, emoji) {
  try {
    await client.invoke(new Api.messages.SendReaction({
      peer,
      msgId,
      reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
    }))
  } catch {
    await client.sendMessage(peer, { message: emoji, replyTo: msgId })
  }
}

/** @param {import('telegram').TelegramClient} client @param {string} query @param {number} limit */
export async function searchPublic(client, query, limit = 20) {
  const res = await client.invoke(new Api.contacts.Search({ q: query, limit }))
  return res.chats || []
}

/**
 * Расширенный поиск публичных каналов/групп по ключевому слову.
 * Возвращает нормализованные записи с сущностью для последующего обогащения.
 * @param {import('telegram').TelegramClient} client @param {string} query @param {number} limit
 */
export async function searchPublicDetailed(client, query, limit = 50) {
  const res = await client.invoke(new Api.contacts.Search({ q: query, limit }))
  const chats = res.chats || []
  return chats
    .filter((c) => c && !c.deactivated)
    .map((c) => ({
      entity: c,
      id: c.id?.toString?.() ?? '',
      title: c.title || c.username || '—',
      username: c.username || c.usernames?.[0]?.username || '',
      members: Number(c.participantsCount ?? 0) || 0,
      isBroadcast: !!c.broadcast,
      isMegagroup: !!c.megagroup,
      isGroup: !c.broadcast,
      hasComments: !!c.megagroup || undefined,
    }))
}

/**
 * Точное число участников через GetFullChannel (когда поиск не отдал participantsCount).
 * @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} entity
 */
export async function getChannelMembersCount(client, entity) {
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))
    return Number(full.fullChat?.participantsCount ?? 0) || 0
  } catch {
    return 0
  }
}

/**
 * @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} chat
 * @param {number} limit @param {{ adminsOnly?: boolean }} [opts]
 */
export async function fetchParticipants(client, chat, limit = 100, opts = {}) {
  const params = { limit }
  if (opts.adminsOnly) params.filter = new Api.ChannelParticipantsAdmins()
  const participants = await client.getParticipants(chat, params)
  return participants.map((u) => ({
    id: u.id?.toString?.() ?? '',
    name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || '—',
    username: u.username || '',
    bot: !!u.bot,
    premium: !!u.premium,
    hasPhoto: !!u.photo,
    deleted: !!u.deleted,
    scam: !!u.scam || !!u.fake,
    verified: !!u.verified,
  }))
}

/** @param {import('telegram').TelegramClient} client */
export async function fetchDialogs(client, limit = 30) {
  const dialogs = await client.getDialogs({ limit })
  return dialogs.map((d) => ({
    id: d.id?.toString?.() ?? '',
    name: d.title || d.name || '—',
    unread: d.unreadCount || 0,
    entity: d.entity,
    lastOut: Boolean(d.message?.out),
    lastMessageId: d.message?.id ?? 0,
  }))
}

/**
 * Помечает диалог (ЛС) прочитанным по уже резолвнутому entity.
 * Используется авто-воркером НейроДиалогов, чтобы не отвечать повторно одному собеседнику.
 * @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} entity
 */
export async function readUserHistory(client, entity) {
  try {
    await client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 }))
    return true
  } catch {
    return false
  }
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} peer */
export async function markStoriesRead(client, peer) {
  try {
    const stories = await client.invoke(new Api.stories.GetPeerStories({ peer }))
    const ids = stories.stories?.stories?.map((s) => s.id) || []
    if (ids.length) {
      await client.invoke(new Api.stories.ReadStories({ peer, maxId: Math.max(...ids) }))
      return ids.length
    }
  } catch { /* ok */ }
  await client.getMessages(peer, { limit: 3 })
  return 1
}

/**
 * @typedef {object} ViewPostsResult
 * @property {number} viewed Количество постов, по которым зарегистрирован просмотр.
 * @property {boolean} isChannel Является ли цель broadcast-каналом (только для них счётчик просмотров имеет смысл).
 * @property {number|null} viewsBefore Просмотры самого нового поста до инкремента (если удалось прочитать).
 * @property {number|null} viewsAfter Просмотры самого нового поста после инкремента (если удалось прочитать).
 * @property {string} reason Код причины пустого результата: '', 'not_channel', 'no_posts', иначе текст ошибки.
 */

/**
 * Просмотреть последние N постов канала: получить историю и зарегистрировать просмотры.
 * count = 1 означает «самый новый пост». Ограничено диапазоном 1..50.
 * Инкремент просмотров засчитывается Telegram только для broadcast-каналов и только
 * один раз на аккаунт: повторные вызовы тем же аккаунтом счётчик не двигают.
 * @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} peer @param {number} count
 * @returns {Promise<ViewPostsResult>}
 */
export async function viewRecentPosts(client, peer, count = 3) {
  const limit = Math.min(Math.max(Math.trunc(Number(count) || 0), 1), 50)
  /** @type {ViewPostsResult} */
  const result = { viewed: 0, isChannel: false, viewsBefore: null, viewsAfter: null, reason: '' }
  try {
    let entity = peer
    try {
      entity = await client.getEntity(peer)
    } catch { /* используем исходный peer как есть */ }

    const isBroadcast = !!(/** @type {{ broadcast?: boolean }} */ (entity)?.broadcast)
    result.isChannel = isBroadcast
    if (!isBroadcast) {
      result.reason = 'not_channel'
      return result
    }

    const history = await client.invoke(new Api.messages.GetHistory({ peer: entity, limit }))
    const ids = (history.messages || [])
      .filter((m) => m?.id && !m.action)
      .map((m) => m.id)
    if (!ids.length) {
      result.reason = 'no_posts'
      return result
    }

    try {
      const before = await client.invoke(new Api.messages.GetMessagesViews({ peer: entity, id: ids, increment: false }))
      const v = before.views?.[0]?.views
      result.viewsBefore = typeof v === 'number' ? v : null
    } catch { /* чтение «до» не критично */ }

    try {
      const incremented = await client.invoke(new Api.messages.GetMessagesViews({ peer: entity, id: ids, increment: true }))
      const v = incremented.views?.[0]?.views
      result.viewsAfter = typeof v === 'number' ? v : null
    } catch (err) {
      result.reason = errMsg(err) || 'views_failed'
      return result
    }

    try {
      await client.invoke(new Api.channels.ReadHistory({ channel: entity, maxId: Math.max(...ids) }))
    } catch { /* дочитывание истории не критично */ }

    result.viewed = ids.length
    return result
  } catch (err) {
    result.reason = errMsg(err) || 'error'
    return result
  }
}

export { mapTelegramError }
