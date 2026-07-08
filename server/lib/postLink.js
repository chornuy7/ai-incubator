/** @param {string} raw */
export function parseTelegramPostLink(raw) {
  const s = raw.trim()
  if (!s) return null

  let m = s.match(/(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)/i)
  if (m) {
    return { kind: 'private', chatId: `-100${m[1]}`, msgId: Number(m[2]), label: s }
  }

  m = s.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)\/(\d+)/i)
  if (m && !['joinchat', 'addstickers', 'share'].includes(m[1].toLowerCase())) {
    return { kind: 'public', username: m[1], msgId: Number(m[2]), label: s }
  }

  return null
}

/** @param {string[]} urls */
export function parseTelegramPostLinks(urls) {
  return (urls || []).map(parseTelegramPostLink).filter(Boolean)
}

/** @param {import('telegram').TelegramClient} client @param {{ kind: string, username?: string, chatId?: string }} parsed */
export async function resolvePostPeer(client, parsed) {
  if (parsed.username) return client.getEntity(parsed.username)
  if (parsed.chatId) return client.getEntity(parsed.chatId)
  throw new Error('INVALID_POST_LINK')
}
