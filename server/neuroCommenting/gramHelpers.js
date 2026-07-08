export {
  ensureJoined,
  resolvePeer,
  joinPeerIfNeeded,
  joinDiscussionGroupIfNeeded,
  membershipLogMessage,
  fetchPosts as fetchChannelPosts,
  sendChannelComment,
  mapTelegramError,
} from '../lib/gramHelpers.js'

/** @param {import('telegram').TelegramClient} client @param {string} raw */
export async function resolveChannel(client, raw) {
  const { ensureJoined } = await import('../lib/gramHelpers.js')
  const r = await ensureJoined(client, raw)
  if (!r.peer) throw new Error(r.status === 'request_sent' ? 'INVITE_REQUEST_SENT' : 'NOT_A_MEMBER')
  return r.peer
}

/** @param {import('telegram').TelegramClient} client @param {import('@types/telegram').Entity} channel */
export async function joinChannelIfNeeded(client, channel) {
  const { joinPeerIfNeeded } = await import('../lib/gramHelpers.js')
  const r = await joinPeerIfNeeded(client, channel)
  return r.status === 'joined'
}
