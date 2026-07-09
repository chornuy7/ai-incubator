import { Router } from 'express'
import { getAiSettings, setAiSettings } from './aiSettings.js'
import { getAiSafety, setAiSafety } from './aiSafety.js'
import { getBlacklist, setBlacklist, addToBlacklist, removeFromBlacklist } from './targetBlacklist.js'
import { listFolders, createFolder, updateFolder, deleteFolder } from './targetFolders.js'

export const featureRouter = Router()

const fail = (res, err, code = 400) =>
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })

// ── (6) Глобальный системный промпт ────────────────────────────────────
featureRouter.get('/ai-settings', async (_req, res) => {
  try {
    res.json({ ok: true, settings: await getAiSettings() })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/ai-settings', async (req, res) => {
  try {
    const patch = req.body ?? {}
    res.json({ ok: true, settings: await setAiSettings(patch) })
  } catch (err) { fail(res, err) }
})

// ── (11) ИИ-безопасность ────────────────────────────────────────────────
featureRouter.get('/ai-safety', async (_req, res) => {
  try {
    res.json({ ok: true, settings: await getAiSafety() })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/ai-safety', async (req, res) => {
  try {
    res.json({ ok: true, settings: await setAiSafety(req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

// ── (10) Чёрный список целей ────────────────────────────────────────────
featureRouter.get('/target-blacklist', async (_req, res) => {
  try {
    res.json({ ok: true, entries: await getBlacklist() })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/target-blacklist', async (req, res) => {
  try {
    const body = req.body ?? {}
    if (Array.isArray(body.entries)) {
      return res.json({ ok: true, entries: await setBlacklist(body.entries) })
    }
    if (body.entry !== undefined) {
      return res.json({ ok: true, entries: await addToBlacklist(body.entry) })
    }
    res.status(400).json({ ok: false, error: 'Укажите entry или entries' })
  } catch (err) { fail(res, err) }
})

featureRouter.delete('/target-blacklist', async (req, res) => {
  try {
    const entry = req.body?.entry ?? req.query?.entry
    if (!entry) return res.status(400).json({ ok: false, error: 'Укажите entry' })
    res.json({ ok: true, entries: await removeFromBlacklist(String(entry)) })
  } catch (err) { fail(res, err) }
})

// ── (5) Папки списков целей ─────────────────────────────────────────────
featureRouter.get('/target-folders', async (_req, res) => {
  try {
    res.json({ ok: true, folders: await listFolders() })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/target-folders', async (req, res) => {
  try {
    const { name, targets } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название папки' })
    res.json({ ok: true, folder: await createFolder(name, targets) })
  } catch (err) { fail(res, err) }
})

featureRouter.put('/target-folders/:id', async (req, res) => {
  try {
    const folder = await updateFolder(req.params.id, req.body ?? {})
    if (!folder) return res.status(404).json({ ok: false, error: 'Папка не найдена' })
    res.json({ ok: true, folder })
  } catch (err) { fail(res, err) }
})

featureRouter.delete('/target-folders/:id', async (req, res) => {
  try {
    const ok = await deleteFolder(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Папка не найдена' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
