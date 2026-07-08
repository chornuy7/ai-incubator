import { Api } from 'telegram/tl/index.js'

/** @param {import('telegram').Api.TypeMessage | undefined} msg */
function previewText(msg) {
  if (!msg) return ''
  if (msg.message?.trim()) return msg.message.trim().slice(0, 120)
  if (msg.media) {
    const cn = msg.media.className || ''
    if (cn.includes('Photo')) return '📷 Фото'
    if (cn.includes('Document')) return '📎 Файл'
    if (cn.includes('Video')) return '🎬 Видео'
    if (cn.includes('Voice')) return '🎤 Голосовое'
    if (cn.includes('Sticker')) return 'Стикер'
    return 'Медиа'
  }
  return ''
}

/** @param {number | undefined} ts */
function formatDialogTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/**
 * @param {import('telegram').TelegramClient} client
 * @param {string} peerId
 * @param {{ accessHash?: string, username?: string }} [opts]
 */
export async function resolvePeerEntity(client, peerId, opts = {}) {
  const { accessHash, username } = opts

  if (username) {
    try {
      return await client.getEntity(username.replace(/^@/, ''))
    } catch { /* try hash below */ }
  }

  if (accessHash) {
    return new Api.InputPeerUser({
      userId: BigInt(peerId),
      accessHash: BigInt(accessHash),
    })
  }

  const dialogs = await client.getDialogs({ limit: 200 })
  for (const d of dialogs) {
    const ent = d.entity
    if (!ent || ent.className !== 'User') continue
    if (`${ent.id}` === `${peerId}`) return ent
  }

  if (username) {
    return client.getEntity(username.replace(/^@/, ''))
  }

  throw new Error(`PEER_NOT_FOUND:${peerId}`)
}

/** @param {import('telegram').TelegramClient} client @param {number} [limit] */
export async function fetchInboxDialogs(client, limit = 100) {
  const dialogs = await client.getDialogs({ limit })
  return dialogs
    .map((d) => {
      const entity = d.entity
      const isUser = entity?.className === 'User'
      if (!isUser) return null
      const name = d.title || d.name || entity?.firstName || '—'
      const username = entity?.username || ''
      const last = previewText(d.message)
      return {
        peerId: `${entity.id}`,
        accessHash: entity.accessHash != null ? `${entity.accessHash}` : undefined,
        name: `${name}${entity.lastName ? ` ${entity.lastName}` : ''}`.trim(),
        username,
        last,
        time: formatDialogTime(d.message?.date),
        unread: d.unreadCount || 0,
        isBot: !!entity?.bot,
      }
    })
    .filter(Boolean)
}

/** @param {import('telegram').TelegramClient} client @param {string} peerId @param {number} [limit] @param {number} [beforeId] @param {{ accessHash?: string, username?: string }} [peerOpts] */
export async function fetchDialogMessages(client, peerId, limit = 60, beforeId = 0, peerOpts = {}) {
  const entity = await resolvePeerEntity(client, peerId, peerOpts)
  const opts = beforeId > 0 ? { limit, maxId: beforeId } : { limit }
  const messages = await client.getMessages(entity, opts)
  const rows = messages
    .filter((m) => m?.id && (m.message || m.media) && !m.action)
    .map((m) => ({
      id: m.id,
      text: previewText(m) || '…',
      time: formatDialogTime(m.date),
      out: !!m.out,
      date: m.date || 0,
    }))
    .sort((a, b) => a.date - b.date)
  return { messages: rows, peerId, hasMore: messages.length >= limit }
}

/** @param {import('telegram').TelegramClient} client @param {string} peerId @param {string} text @param {{ accessHash?: string, username?: string }} [peerOpts] */
export async function sendDialogMessage(client, peerId, text, peerOpts = {}) {
  const entity = await resolvePeerEntity(client, peerId, peerOpts)
  const msg = await client.sendMessage(entity, { message: text })
  return {
    id: msg.id,
    text: msg.message || text,
    time: formatDialogTime(msg.date),
    out: true,
    date: msg.date || Math.floor(Date.now() / 1000),
  }
}

/** @param {import('telegram').TelegramClient} client @param {string} peerId @param {{ accessHash?: string, username?: string }} [peerOpts] */
export async function markDialogRead(client, peerId, peerOpts = {}) {
  try {
    const entity = await resolvePeerEntity(client, peerId, peerOpts)
    await client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 }))
  } catch { /* optional */ }
}
