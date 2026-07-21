import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta } from '../accountsMeta.js'
import { mapTelegramError } from '../lib/protection.js'
import { fetchInboxDialogs, fetchDialogMessages, sendDialogMessage, markDialogRead, fetchMessageThumb } from './inbox.js'
import { accountFingerprint } from '../lib/deviceFingerprint.js'

/** @param {string} accountId @param {(client: import('telegram').TelegramClient, meta: object) => Promise<T>} fn @template T */
async function withClient(accountId, fn) {
  const meta = await getAccountMeta(accountId)
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) throw new Error('NO_SESSION')
  const client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
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

/**
 * §3: кэш превью в ПАМЯТИ (не на диске — храним ровно то, что нельзя не хранить).
 * Без него каждый ре-рендер списка поднимал бы Telegram-сессию заново: превью
 * дешёвое, а вот подключение аккаунта — нет, и Telegram такое частое переподключение
 * не любит. Живёт TTL, размер ограничен — это кэш, а не хранилище.
 */
const THUMB_TTL_MS = 10 * 60_000
const THUMB_MAX_ENTRIES = 300
/** @type {Map<string, {buf: Buffer|null, at: number}>} */
const thumbCache = new Map()

function cacheGet(key) {
  const hit = thumbCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > THUMB_TTL_MS) { thumbCache.delete(key); return undefined }
  // перекладываем в конец — простой LRU поверх порядка вставки Map
  thumbCache.delete(key)
  thumbCache.set(key, hit)
  return hit.buf
}

function cacheSet(key, buf) {
  thumbCache.set(key, { buf, at: Date.now() })
  while (thumbCache.size > THUMB_MAX_ENTRIES) thumbCache.delete(thumbCache.keys().next().value)
}

/**
 * §3: превью сообщения по запросу. Кэш отвечает и на «превью нет» (null),
 * чтобы не дёргать Telegram повторно из-за сообщений без миниатюры.
 * @returns {Promise<Buffer|null>}
 */
export async function loadMessageThumb(accountId, peerId, messageId, peerOpts = {}) {
  const key = `${accountId}:${peerId}:${messageId}`
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  const buf = await withClient(accountId, (client) => fetchMessageThumb(client, peerId, messageId, peerOpts))
  cacheSet(key, buf)
  return buf
}

export { mapTelegramError }
