import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta } from '../accountsMeta.js'
import { mapTelegramError } from '../lib/protection.js'
import { fetchInboxDialogs, fetchDialogMessages, sendDialogMessage, markDialogRead } from './inbox.js'

/** @param {string} accountId @param {(client: import('telegram').TelegramClient, meta: object) => Promise<T>} fn @template T */
async function withClient(accountId, fn) {
  const meta = await getAccountMeta(accountId)
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) throw new Error('NO_SESSION')
  const client = await createClient(sessionStr, meta.proxy)
  try {
    return await fn(client, meta)
  } finally {
    try {
      await client.disconnect()
    } catch { /* ignore */ }
  }
}

/** @param {string[]} accountIds @param {number} limit */
export async function loadMergedInbox(accountIds, limit = 100) {
  const dialogs = []
  for (const accountId of accountIds) {
    const meta = await getAccountMeta(accountId)
    try {
      const rows = await withClient(accountId, (client) => fetchInboxDialogs(client, limit))
      for (const d of rows) {
        dialogs.push({
          ...d,
          accountId,
          accountName: meta.name || accountId,
          key: `${accountId}:${d.peerId}`,
        })
      }
    } catch (err) {
      dialogs.push({
        key: `err:${accountId}`,
        accountId,
        accountName: meta.name || accountId,
        peerId: '',
        name: 'Ошибка загрузки',
        username: '',
        last: err instanceof Error ? err.message : 'Ошибка',
        time: '',
        unread: 0,
        error: true,
      })
    }
  }
  dialogs.sort((a, b) => {
    if (a.unread !== b.unread) return b.unread - a.unread
    return (a.name || '').localeCompare(b.name || '', 'ru')
  })
  return dialogs
}

export async function loadMessages(accountId, peerId, limit = 60, beforeId = 0, peerOpts = {}) {
  return withClient(accountId, (client) => fetchDialogMessages(client, peerId, limit, beforeId, peerOpts))
}

export async function sendMessage(accountId, peerId, text, peerOpts = {}) {
  return withClient(accountId, async (client) => {
    const msg = await sendDialogMessage(client, peerId, text.trim(), peerOpts)
    await markDialogRead(client, peerId, peerOpts)
    return msg
  })
}

export async function readDialog(accountId, peerId, peerOpts = {}) {
  return withClient(accountId, (client) => markDialogRead(client, peerId, peerOpts))
}

export { mapTelegramError }
