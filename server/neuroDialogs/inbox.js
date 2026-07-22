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

/**
 * §3: тип медиа сообщения — фронт по нему решает, тянуть превью или показать значок.
 * Оригиналы мы не храним и не качаем: превью подгружается отдельным запросом (thumb).
 * @returns {'photo'|'video'|'sticker'|'voice'|'file'|null}
 */
export function mediaKind(msg) {
  const cn = msg?.media?.className || ''
  if (!cn) return null
  if (cn.includes('Photo')) return 'photo'
  const attrs = msg?.media?.document?.attributes || []
  const has = (n) => attrs.some((a) => `${a.className || ''}`.includes(n))
  if (has('Sticker')) return 'sticker'
  if (has('Video')) return 'video'
  if (has('Audio')) return 'voice'
  return 'file'
}

/** Есть ли у медиа превью, которое имеет смысл показывать картинкой. */
const THUMBABLE = new Set(['photo', 'video', 'sticker'])

/**
 * §3: превью медиа ON-DEMAND — тянем из Telegram по запросу самый маленький thumb
 * и НЕ сохраняем на диск. Оригинал (мегабайты видео) не качаем никогда.
 * @returns {Promise<Buffer|null>} null, если превью нет
 */
export async function fetchMessageThumb(client, peerId, messageId, peerOpts = {}) {
  const entity = await resolvePeerEntity(client, peerId, peerOpts)
  const found = await client.getMessages(entity, { ids: [Number(messageId)] })
  const msg = Array.isArray(found) ? found[0] : found
  if (!msg?.media || !THUMBABLE.has(mediaKind(msg))) return null
  // Берём САМУЮ КРУПНУЮ доступную миниатюру, укладывающуюся в потолок по весу.
  // Раньше стояло `thumb: 0` — самый мелкий размер: превью выходили по 660–800 байт,
  // размытыми квадратиками, а скриншот таблицы превращался в белое пятно. Смысл
  // превью в том, чтобы УВИДЕТЬ, что прислали, поэтому идём от крупного к мелкому
  // и останавливаемся на первом, что влезает в лимит (прогон 21–22.07, тест 4.5).
  // Оригинал (мегабайты видео) по-прежнему не качаем никогда.
  const MAX_THUMB_BYTES = 40 * 1024
  const sizes = msg.media?.photo?.sizes || msg.media?.document?.thumbs || []
  // Индексы миниатюр от крупной к мелкой; если размеров не видно — пробуем 2, 1, 0.
  const order = sizes.length ? [...sizes.keys()].reverse() : [2, 1, 0]
  let fallback = null
  for (const thumb of order) {
    let buf
    try {
      buf = await client.downloadMedia(msg, { thumb })
    } catch { continue } // размера нет или он недоступен — пробуем следующий
    if (!buf || !buf.length) continue
    const out = Buffer.from(buf)
    if (out.length <= MAX_THUMB_BYTES) return out
    fallback = out // всё крупнее лимита — запомним на случай, что мельче не найдётся
  }
  return fallback
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
        // Сырая отметка времени нужна фронту для сортировки «новое сверху»: раньше
        // наружу уходила только готовая строка вроде «28 мая», и пересортировать
        // список было физически нечем (прогон 21–22.07, тест 4.6).
        ts: Number(d.message?.date || 0),
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
      // §3: только ТИП медиа. Само превью фронт запросит отдельно и лишь для видимых сообщений.
      ...(m.media ? { media: mediaKind(m), hasThumb: THUMBABLE.has(mediaKind(m)) } : {}),
    }))
    .sort((a, b) => a.date - b.date)
  return { messages: rows, peerId, hasMore: messages.length >= limit }
}

/** @param {import('telegram').TelegramClient} client @param {string} peerId @param {string} text @param {{ accessHash?: string, username?: string }} [peerOpts] */
export async function sendDialogMessage(client, peerId, text, peerOpts = {}) {
  const entity = await resolvePeerEntity(client, peerId, peerOpts)
  // §9: ручной ответ поддерживает Telegram-разметку (жирный/курсив/ссылка).
  // Markdown с фолбеком на обычный текст, если разметка малформед.
  let msg
  try { msg = await client.sendMessage(entity, { message: text, parseMode: 'md' }) }
  catch { msg = await client.sendMessage(entity, { message: text }) }
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
