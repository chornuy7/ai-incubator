/**
 * §2: роуты массового импорта аккаунтов. Монтируются в /api/tg/import.
 *
 * Путь «с диска» (browse/scan/run) читает файлы там, где они лежат: ничего никуда не
 * копируется, папка tdata на 50 МБ не гоняется по HTTP. Это работает, когда бэкенд
 * запущен на той же машине, где аккаунты, — то есть в обычном локальном режиме.
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { scanFolder, listDirs } from './lib/accountScan.js'
import { distributeProxies, importOne, existingAccountKeys, isKnownByPhone } from './lib/accountImport.js'
import { listProxies, toProxyUrl } from './proxies.js'
import { loadAllMeta } from './accountsMeta.js'
import { appendAudit } from './lib/auditLog.js'

export const importRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/** Проводник по папкам сервера — чтобы не заставлять человека вручную писать путь. */
importRouter.post('/browse', async (req, res) => {
  try {
    const dir = String(req.body?.path || '')
    res.json({ ok: true, path: dir, ...(await listDirs(dir)) })
  } catch (err) { fail(res, err) }
})

/** Найти аккаунты в папке. Ничего не импортирует — только показывает, что нашлось. */
importRouter.post('/scan', async (req, res) => {
  try {
    const dir = String(req.body?.path || '').trim()
    if (!dir) return res.status(400).json({ ok: false, error: 'Укажите папку' })
    const stat = await fs.stat(dir).catch(() => null)
    if (!stat?.isDirectory()) return res.status(400).json({ ok: false, error: 'Папка не найдена' })

    const { items, scannedDirs } = await scanFolder(dir, { passcode: req.body?.passcode, maxDepth: Number(req.body?.maxDepth) || undefined })
    const keys = await existingAccountKeys()
    // Помечаем уже заведённые — по телефону это видно ещё до конвертации.
    const marked = items.map((it) => ({ ...it, known: isKnownByPhone(keys, it.phone) }))
    res.json({
      ok: true,
      items: marked,
      scannedDirs,
      tdata: marked.filter((i) => i.kind === 'tdata').length,
      files: marked.filter((i) => i.kind === 'session-file').length,
    })
  } catch (err) { fail(res, err) }
})

/**
 * Импортировать отмеченное. Идёт последовательно: каждая сессия — это подключение
 * к Telegram, разом их открывать нельзя (и по лимитам, и по прокси).
 */
importRouter.post('/run', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) return res.status(400).json({ ok: false, error: 'Нечего импортировать' })
    const { proxyMode = 'pool', proxyIds = [], singleProxy = '', validate = true, passcode = '' } = req.body ?? {}

    // Пул прокси: берём выбранные (или все живые) и исключаем уже занятые аккаунтами.
    const all = await listProxies()
    const chosen = proxyIds.length ? all.filter((p) => proxyIds.includes(p.id)) : all.filter((p) => p.status !== 'dead')
    const meta = await loadAllMeta()
    const busy = new Set(Object.values(meta || {}).map((m) => m?.proxy).filter((u) => u && u !== '—'))
    const assigned = distributeProxies(items, {
      mode: proxyMode,
      proxyUrls: chosen.map(toProxyUrl),
      single: singleProxy,
      busy,
    })

    const results = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const proxy = assigned[i]
      if (proxyMode === 'pool' && !proxy) {
        results.push({ name: it.name, ok: false, reason: 'не хватило свободных прокси в пуле' })
        continue
      }
      try {
        const r = await importOne(it, { proxy, validate, passcode })
        results.push({ name: it.name, proxy: proxy || null, ...r })
      } catch (e) {
        results.push({ name: it.name, ok: false, reason: e instanceof Error ? e.message : 'ошибка импорта' })
      }
    }

    const imported = results.filter((r) => r.ok)
    await appendAudit({
      action: 'account.import',
      module: 'accounts',
      initiator: 'operator',
      reason: `Импорт аккаунтов: добавлено ${imported.length} из ${items.length}`,
      meta: { total: items.length, imported: imported.length, proxyMode, validate },
    }).catch(() => {})

    res.json({ ok: true, results, imported: imported.length, failed: results.length - imported.length })
  } catch (err) { fail(res, err, 500) }
})

/** Подсказка для UI: сколько прокси реально свободно под импорт. */
importRouter.get('/proxy-capacity', async (_req, res) => {
  try {
    const all = await listProxies()
    const meta = await loadAllMeta()
    const busy = new Set(Object.values(meta || {}).map((m) => m?.proxy).filter((u) => u && u !== '—'))
    const free = all.filter((p) => p.status !== 'dead' && !busy.has(toProxyUrl(p)))
    res.json({ ok: true, total: all.length, free: free.length, freeIds: free.map((p) => p.id) })
  } catch (err) { fail(res, err, 500) }
})

export default importRouter
