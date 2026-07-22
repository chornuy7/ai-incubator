import { Router } from 'express'
import { getAiSettings, setAiSettings } from './aiSettings.js'
import { getAiSafety, setAiSafety } from './aiSafety.js'
import { getBlacklist, setBlacklist, addToBlacklist, removeFromBlacklist } from './targetBlacklist.js'
import { listFolders, createFolder, updateFolder, deleteFolder } from './targetFolders.js'
import { loadAllMeta, getAccountMeta } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { sleep } from './lib/protection.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { foldersForRequest, isAdminRequest } from './lib/accessGuard.js'
import { appendAudit } from './lib/auditLog.js'

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
// §8.1: отдаём только разрешённые роли папки и только разрешённые каналы внутри них.
// До этого стоял `_req` — запрос не читался вовсе, и списки каналов всех ролей уходили
// любому, кто дёрнет URL (прогон 21–22.07, тест 11.7).
featureRouter.get('/target-folders', async (req, res) => {
  try {
    res.json({ ok: true, folders: await foldersForRequest(req, await listFolders()) })
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
    const patch = req.body ?? {}
    // §8.1: переименование — управление папкой, только админ. Дозапись целей
    // («Сохранить в папку») доступна всем, у кого папка вообще видна.
    if (typeof patch.name === 'string' && !(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Переименовать папку может только администратор' })
    }
    if (patch.targets !== undefined) {
      const visible = await foldersForRequest(req, await listFolders())
      if (!visible.some((f) => f.id === req.params.id)) {
        return res.status(403).json({ ok: false, error: 'Нет доступа к этой папке' })
      }
    }
    const before = (await listFolders()).find((f) => f.id === req.params.id)
    const folder = await updateFolder(req.params.id, patch)
    if (!folder) return res.status(404).json({ ok: false, error: 'Папка не найдена' })
    // §3.1: папка — база для массовой рассылки; подмена её содержимого должна оставлять след.
    await appendAudit({
      action: 'folder.update',
      module: 'folders',
      initiator: req.header('x-user-id') || 'operator',
      reason: patch.name !== undefined
        ? `Переименована: «${before?.name ?? '—'}» → «${folder.name}»`
        : `Цели папки «${folder.name}»: было ${before?.targets?.length ?? 0} → стало ${folder.targets.length}`,
      scope: { folderId: folder.id },
      meta: { before: before?.targets?.length ?? 0, after: folder.targets.length },
    }).catch(() => {})
    res.json({ ok: true, folder })
  } catch (err) { fail(res, err) }
})

featureRouter.delete('/target-folders/:id', async (req, res) => {
  try {
    // §8.1: удаление папки — необратимо и только для админа (фронт это и так подразумевал).
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Удалить папку может только администратор' })
    }
    const before = (await listFolders()).find((f) => f.id === req.params.id)
    const ok = await deleteFolder(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Папка не найдена' })
    await appendAudit({
      action: 'folder.delete',
      module: 'folders',
      initiator: req.header('x-user-id') || 'operator',
      reason: `Удалена папка «${before?.name ?? req.params.id}» (${before?.targets?.length ?? 0} целей)`,
      scope: { folderId: req.params.id },
    }).catch(() => {})
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

// Валидация папки: проверяем, что каждая цель ещё существует/доступна в Telegram,
// «мёртвые» (не резолвятся) удаляем из папки. Так база чатов остаётся рабочей.
featureRouter.post('/target-folders/:id/validate', async (req, res) => {
  try {
    const folders = await listFolders()
    const folder = folders.find((f) => f.id === req.params.id)
    if (!folder) return res.status(404).json({ ok: false, error: 'Папка не найдена' })
    const targets = folder.targets || []
    if (!targets.length) return res.json({ ok: true, checked: 0, kept: 0, removed: 0, folder })

    // Выбираем аккаунт: из тела запроса или первый валидный из панели.
    let accountId = req.body?.accountId
    if (!accountId) {
      const meta = await loadAllMeta()
      accountId = Object.keys(meta).find((id) => !meta[id].inTrash && (meta[id].status === 'active' || !meta[id].status))
    }
    if (!accountId) return res.status(400).json({ ok: false, error: 'Нет доступного аккаунта для проверки' })

    const meta = await getAccountMeta(accountId)
    const sessionStr = await loadSessionString(accountId)
    if (!sessionStr) return res.status(400).json({ ok: false, error: 'Сессия аккаунта недоступна' })

    const client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
    const valid = []
    try {
      for (const t of targets) {
        try { const e = await client.getEntity(t); if (e) valid.push(t) } catch { /* мёртвая цель — не сохраняем */ }
        await sleep(400)
      }
    } finally {
      try { await client.disconnect() } catch { /* */ }
    }

    const removed = targets.length - valid.length
    const updated = await updateFolder(folder.id, { targets: valid })
    res.json({ ok: true, checked: targets.length, kept: valid.length, removed, folder: updated })
  } catch (err) { fail(res, err) }
})
