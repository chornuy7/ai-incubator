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
  await joinDiscussionGroupIfNeeded(client, channel)
  try {
    await client.sendMessage(channel, { message: text, commentTo: postId })
    return
  } catch { /* fallback */ }
  const discussion = await client.invoke(new Api.messages.GetDiscussionMessage({ peer: channel, msgId: postId }))
  const msg = discussion.messages?.[0]
  if (!msg) throw new Error('NO_DISCUSSION')
  const peer = discussion.chats?.[0] || msg.peerId
  if (peer) await joinPeerIfNeeded(client, peer)
  await client.sendMessage(peer, { message: text, replyTo: msg.id })
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
  }))
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

export { mapTelegramError }
