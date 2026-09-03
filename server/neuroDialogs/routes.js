import { Router } from 'express'
import { loadMergedInbox, loadMessages, sendMessage, readDialog, loadMessageThumb, mapTelegramError } from './service.js'
import { canSeeAccount } from '../lib/accessGuard.js'

function peerOptsFromQuery(query) {
  const accessHash = query.accessHash ? `${query.accessHash}` : undefined
  const username = query.username ? `${query.username}`.replace(/^@/, '') : undefined
  return { accessHash, username }
}

export const neuroDialogsRouter = Router()

/*
 * Аудит 21.08: во всём этом роутере `accountId` брался из адреса и шёл в Telegram без
 * единой проверки, чей это аккаунт. Гейт на монтировании (`moduleAccessGuard` в index.js)
 * отвечает только на вопрос «оплачен ли модуль НейроДиалоги», а не «твой ли это аккаунт»,
 * и потому пропускал всё: чужие диалоги на чтение, тексты переписки — и `POST`, то есть
 * ОТПРАВКУ СООБЩЕНИЯ ОТ ИМЕНИ ЧУЖОГО АККАУНТА. Последнее уже не утечка, а действие в
 * Telegram чужими руками: отвечает чужой профиль, а прилетает — его владельцу.
 *
 * Проверку вешаем на параметр маршрута, а не в каждый хендлер: так её нельзя забыть в
 * роуте, которого ещё нет. Ровно этим забыванием дыра и объясняется — часть роутера
 * писалась позже остального.
 */
neuroDialogsRouter.param('accountId', (req, res, next, accountId) => {
  canSeeAccount(req, accountId)
    .then((ok) => (ok ? next() : res.status(403).json({ ok: false, error: 'Это не ваш аккаунт' })))
    .catch(() => res.status(403).json({ ok: false, error: 'Не удалось проверить доступ к аккаунту' }))
})

neuroDialogsRouter.get('/inbox', async (req, res) => {
  try {
    const raw = `${req.query.accountIds || ''}`
    const accountIds = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!accountIds.length) {
      return res.status(400).json({ ok: false, error: 'Укажите accountIds' })
    }
    // Здесь аккаунты приходят списком в query, поэтому `param` их не ловит. Чужие молча
    // отбрасываем, а не отвечаем ошибкой: во фронте список аккаунтов и так свой, и если
    // туда затесался чужой id — это не повод отменять показ собственных диалогов.
    const allowed = []
    for (const id of accountIds) if (await canSeeAccount(req, id)) allowed.push(id)
    if (!allowed.length) return res.status(403).json({ ok: false, error: 'Нет доступа к этим аккаунтам' })
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100))
    const dialogs = await loadMergedInbox(allowed, limit)
    const unread = dialogs.reduce((s, d) => s + (d.unread || 0), 0)
    res.json({ ok: true, dialogs, unread, total: dialogs.length })
  } catch (err) {
    res.status(500).json({ ok: false, error: mapTelegramError(err) })
  }
})

neuroDialogsRouter.get('/:accountId/messages/:peerId', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 60))
    const beforeId = Number(req.query.beforeId) || 0
    const peerOpts = peerOptsFromQuery(req.query)
    const data = await loadMessages(req.params.accountId, req.params.peerId, limit, beforeId, peerOpts)
    res.json({ ok: true, ...data })
  } catch (err) {
    res.status(400).json({ ok: false, error: mapTelegramError(err) })
  }
})

neuroDialogsRouter.post('/:accountId/messages/:peerId', async (req, res) => {
  try {
    const text = `${req.body?.text || ''}`.trim()
    if (!text) return res.status(400).json({ ok: false, error: 'Пустое сообщение' })
    const peerOpts = {
      accessHash: req.body?.accessHash ? `${req.body.accessHash}` : undefined,
      username: req.body?.username ? `${req.body.username}`.replace(/^@/, '') : undefined,
    }
    const message = await sendMessage(req.params.accountId, req.params.peerId, text, peerOpts)
    res.json({ ok: true, message })
  } catch (err) {
    res.status(400).json({ ok: false, error: mapTelegramError(err) })
  }
})

/**
 * §3: превью картинки/видео ON-DEMAND. Оригинал не храним и не качаем — отдаём
 * самый мелкий thumb прямо из живой сессии. 404 = превью у сообщения нет
 * (файл, голосовое), это нормальный ответ, а не ошибка.
 */
neuroDialogsRouter.get('/:accountId/media/:peerId/:messageId', async (req, res) => {
  try {
    const peerOpts = peerOptsFromQuery(req.query)
    const buf = await loadMessageThumb(req.params.accountId, req.params.peerId, req.params.messageId, peerOpts)
    if (!buf) return res.status(404).end()
    res.set('Content-Type', 'image/jpeg')
    res.set('Cache-Control', 'private, max-age=600') // столько же, сколько живёт кэш на сервере
    res.send(buf)
  } catch (err) {
    res.status(400).json({ ok: false, error: mapTelegramError(err) })
  }
})

neuroDialogsRouter.post('/:accountId/read/:peerId', async (req, res) => {
  try {
    const peerOpts = peerOptsFromQuery(req.query)
    await readDialog(req.params.accountId, req.params.peerId, peerOpts)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, error: mapTelegramError(err) })
  }
})
