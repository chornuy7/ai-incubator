import { Router } from 'express'
import { getAiSettings, setAiSettings } from './aiSettings.js'
import { getUserPrompts, saveUserPrompts } from './userPrompts.js'
import { getAiSafety, setAiSafety } from './aiSafety.js'
import { getBlacklist, setBlacklist, addToBlacklist, removeFromBlacklist } from './targetBlacklist.js'
import { listFolders, createFolder, updateFolder, deleteFolder } from './targetFolders.js'
import { loadAllMeta, getAccountMeta } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { sleep } from './lib/protection.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { foldersForRequest, isAdminRequest, ownedForRequest, ownerScopeForRequest, ownsRecord, canSeeAccount } from './lib/accessGuard.js'
import { appendAudit } from './lib/auditLog.js'

export const featureRouter = Router()

const fail = (res, err, code = 400) =>
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })

// ── MR-185: тексты промптов модулей — по владельцу ─────────────────────
//
// Владелец берётся ИЗ СЕССИИ, а не из параметров запроса: иначе чужие промпты читались
// бы подстановкой чужого id. До этой ручки тексты лежали в памяти браузера без имени
// владельца — правка одного человека доставалась всем, кто заходит с того же компьютера.
featureRouter.get('/prompts', async (req, res) => {
  try {
    const userId = req.header('x-user-id') || ''
    if (!userId) return fail(res, new Error('Нет сессии'), 401)
    const moduleKey = String(req.query.moduleKey || '')
    if (!moduleKey) return fail(res, new Error('Не указан модуль'))
    res.json({ ok: true, prompts: await getUserPrompts(userId, moduleKey) })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.put('/prompts', async (req, res) => {
  try {
    const userId = req.header('x-user-id') || ''
    if (!userId) return fail(res, new Error('Нет сессии'), 401)
    const { moduleKey, bodies, defaults } = req.body ?? {}
    if (!moduleKey) return fail(res, new Error('Не указан модуль'))
    if (!Array.isArray(bodies)) return fail(res, new Error('Нет текстов промптов'))
    const saved = await saveUserPrompts(userId, String(moduleKey), bodies, Array.isArray(defaults) ? defaults : [])
    res.json({ ok: true, prompts: saved })
  } catch (err) { fail(res, err, 500) }
})

/*
 * ── (6) Глобальный системный промпт — ЛИЧНЫЙ у каждого ─────────────────
 *
 * Был один на всю платформу: админ дописал себе строку — она уехала всем, включая чужие
 * кабинеты и все их запуски. Владелец 27.08: правка под администратором остаётся у
 * администратора, под тестовым модератором — у него; на другие аккаунты не переходит.
 *
 * Владелец берётся ИЗ СЕССИИ, а не из параметров: иначе чужой промпт читался бы и
 * переписывался подстановкой чужого id. Пока человек ничего не сохранял, отдаём прежний
 * общий текст — иначе в день выката у всех разом пропал бы уже настроенный промпт.
 */
featureRouter.get('/ai-settings', async (req, res) => {
  try {
    const userId = req.header('x-user-id') || ''
    if (!userId) return fail(res, new Error('Нет сессии'), 401)
    const { getUserGlobalPrompt } = await import('./userAiSettings.js')
    res.json({ ok: true, settings: { globalSystemPrompt: await getUserGlobalPrompt(userId) } })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/ai-settings', async (req, res) => {
  try {
    const userId = req.header('x-user-id') || ''
    if (!userId) return fail(res, new Error('Нет сессии'), 401)
    const patch = req.body ?? {}
    if (typeof patch.globalSystemPrompt !== 'string') return fail(res, new Error('Нет текста промпта'))
    const { setUserGlobalPrompt } = await import('./userAiSettings.js')
    const saved = await setUserGlobalPrompt(userId, patch.globalSystemPrompt)
    res.json({ ok: true, settings: { globalSystemPrompt: saved } })
  } catch (err) { fail(res, err) }
})

// ── (11) ИИ-безопасность ────────────────────────────────────────────────
featureRouter.get('/ai-safety', async (_req, res) => {
  try {
    res.json({ ok: true, settings: await getAiSafety() })
  } catch (err) { fail(res, err, 500) }
})

// Лимиты ИИ-безопасности общие: ослабив их у себя, клиент ослаблял защиту на чужих
// аккаунтах — а платит за спамблок их владелец.
featureRouter.post('/ai-safety', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Это общая настройка платформы — менять её может только администратор' })
    }
    res.json({ ok: true, settings: await setAiSafety(req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

// ── (10) Чёрный список целей ────────────────────────────────────────────
featureRouter.get('/target-blacklist', async (_req, res) => {
  try {
    res.json({ ok: true, entries: await getBlacklist() })
  } catch (err) { fail(res, err, 500) }
})

// Чёрный список целей тоже один на платформу. Через `entries` его можно было заменить
// целиком — то есть одним запросом снять чужие запреты и пустить рассылку туда, куда
// сосед её осознанно закрыл.
featureRouter.post('/target-blacklist', async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Чёрный список общий для платформы — менять его может только администратор' })
    }
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
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Чёрный список общий для платформы — менять его может только администратор' })
    }
    const entry = req.body?.entry ?? req.query?.entry
    if (!entry) return res.status(400).json({ ok: false, error: 'Укажите entry' })
    res.json({ ok: true, entries: await removeFromBlacklist(String(entry)) })
  } catch (err) { fail(res, err) }
})

// ── (5) Папки списков целей ─────────────────────────────────────────────
// Две независимые оси, и до 21.08 работала только вторая:
//   1) ВЛАДЕЛЕЦ пространства — `ownedForRequest`: чужая папка не наша, точка. Этой оси
//      не было вовсе (у папки не хранился владелец), а роль обычного клиента раздела
//      `folders` не содержит и потому не режет ничего — базы каналов всех клиентов
//      платформы уходили каждому, кто дёрнет URL;
//   2) РОЛЬ внутри своего пространства — `foldersForRequest` (§8.1, прогон 21–22.07,
//      тест 11.7): сотруднику владелец может сузить список папок и каналов в них.
featureRouter.get('/target-folders', async (req, res) => {
  try {
    const mine = await ownedForRequest(req, await listFolders())
    res.json({ ok: true, folders: await foldersForRequest(req, mine) })
  } catch (err) { fail(res, err, 500) }
})

featureRouter.post('/target-folders', async (req, res) => {
  try {
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    const { name, targets } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Укажите название папки' })
    // Хозяин записи — владелец пространства (как у прокси и целей): суб создаёт папку
    // владельцу, а не себе, иначе она пропадёт из виду при смене сотрудника.
    res.json({ ok: true, folder: await createFolder(name, targets, scope.ownerId) })
  } catch (err) { fail(res, err) }
})

featureRouter.put('/target-folders/:id', async (req, res) => {
  try {
    const patch = req.body ?? {}
    const all = await listFolders()
    const target = all.find((f) => f.id === req.params.id)
    // Владелец проверяется ПЕРВЫМ и для любой правки: id папки не секрет (он в ссылках и
    // в ответах соседних роутов), а дозапись целей в чужую папку — это подмена базы,
    // по которой сосед завтра запустит рассылку своими аккаунтами.
    if (!(await ownsRecord(req, target))) {
      return res.status(403).json({ ok: false, error: 'Это не ваша папка' })
    }
    // §8.1: переименование — управление папкой, только админ. Дозапись целей
    // («Сохранить в папку») доступна всем, у кого папка вообще видна.
    if (typeof patch.name === 'string' && !(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: 'Переименовать папку может только администратор' })
    }
    if (patch.targets !== undefined) {
      const visible = await foldersForRequest(req, all)
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
    // Валидация переписывает содержимое папки (мёртвые цели удаляются) — на чужой папке
    // это чистая порча данных, поэтому владельца спрашиваем до всякой работы.
    if (!(await ownsRecord(req, folder))) {
      return res.status(403).json({ ok: false, error: 'Это не ваша папка' })
    }
    const targets = folder.targets || []
    if (!targets.length) return res.json({ ok: true, checked: 0, kept: 0, removed: 0, folder })

    // Аккаунт для проверки — только СВОЙ. Раньше сюда брался «первый валидный из панели»,
    // то есть проверка сотнями getEntity шла с ЧУЖОГО Telegram-аккаунта: риск флуда и
    // спамблока доставался его владельцу, а результат — автору запроса.
    let accountId = req.body?.accountId
    if (accountId) {
      if (!(await canSeeAccount(req, accountId))) {
        return res.status(403).json({ ok: false, error: 'Этот аккаунт вам недоступен' })
      }
    } else {
      const meta = await loadAllMeta()
      for (const id of Object.keys(meta)) {
        const m = meta[id]
        if (m.inTrash || (m.status && m.status !== 'active')) continue
        if (!(await canSeeAccount(req, id))) continue
        accountId = id
        break
      }
    }
    if (!accountId) return res.status(400).json({ ok: false, error: 'Нет доступного вам аккаунта для проверки' })

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
