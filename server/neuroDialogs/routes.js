import { Router } from 'express'
import { loadMergedInbox, loadMessages, sendMessage, readDialog, mapTelegramError } from './service.js'

function peerOptsFromQuery(query) {
  const accessHash = query.accessHash ? `${query.accessHash}` : undefined
  const username = query.username ? `${query.username}`.replace(/^@/, '') : undefined
  return { accessHash, username }
}

export const neuroDialogsRouter = Router()

neuroDialogsRouter.get('/inbox', async (req, res) => {
  try {
    const raw = `${req.query.accountIds || ''}`
    const accountIds = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!accountIds.length) {
      return res.status(400).json({ ok: false, error: 'Укажите accountIds' })
    }
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100))
    const dialogs = await loadMergedInbox(accountIds, limit)
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

neuroDialogsRouter.post('/:accountId/read/:peerId', async (req, res) => {
  try {
    const peerOpts = peerOptsFromQuery(req.query)
    await readDialog(req.params.accountId, req.params.peerId, peerOpts)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, error: mapTelegramError(err) })
  }
})
