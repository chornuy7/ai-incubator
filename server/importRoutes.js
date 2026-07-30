/**
 * §2: роуты массового импорта аккаунтов. Монтируются в /api/tg/import.
 *
 * Путь «с диска» (browse/scan/run) читает файлы там, где они лежат: ничего никуда не
 * копируется, папка tdata на 50 МБ не гоняется по HTTP. Это работает, когда бэкенд
 * запущен на той же машине, где аккаунты, — то есть в обычном локальном режиме.
 */
import { Router } from 'express'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import fs from 'fs/promises'
import multer from 'multer'
import { scanFolder, listDirs } from './lib/accountScan.js'
import { distributeProxies, pairByOrder, importOne, existingAccountKeys, isKnownByPhone } from './lib/accountImport.js'
import { listProxies, toProxyUrl } from './proxies.js'
import { loadAllMeta, setAccountMeta, countryFromPhone } from './accountsMeta.js'
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
    const { proxyMode = 'pool', proxyIds = [], singleProxy = '', manualProxies = [], validate = true, passcode = '', root = '' } = req.body ?? {}

    // Пути приходят от клиента, поэтому импортировать разрешаем только из той папки,
    // которую перед этим сканировали (или куда залили файлы). Иначе через этот роут
    // можно было бы ткнуть в произвольный файл на сервере.
    if (root) {
      const base = path.resolve(String(root))
      const outside = items.find((it) => {
        const p = path.resolve(String(it?.path || ''))
        return p !== base && !p.startsWith(base + path.sep)
      })
      if (outside) return res.status(400).json({ ok: false, error: 'Путь вне просканированной папки' })
    }

    // Пул прокси: берём выбранные (или все живые) и исключаем уже занятые аккаунтами.
    const all = await listProxies()
    const chosen = proxyIds.length ? all.filter((p) => proxyIds.includes(p.id)) : all.filter((p) => p.status !== 'dead')
    const meta = await loadAllMeta()
    const busy = new Set(Object.values(meta || {}).map((m) => m?.proxy).filter((u) => u && u !== '—'))
    const assigned = distributeProxies(items, {
      mode: proxyMode,
      proxyUrls: chosen.map(toProxyUrl),
      single: singleProxy,
      // `manual` — раскладка из таблицы «аккаунт ↔ прокси»: оператор её уже видел
      // и поправил, переставлять нельзя.
      manual: manualProxies,
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
      // §11.1: реальный инициатор — иначе импорт не попадёт в журнал активности юзера.
      initiator: req.header('x-user-id') || 'operator',
      reason: `Импорт аккаунтов: добавлено ${imported.length} из ${items.length}`,
      meta: { total: items.length, imported: imported.length, proxyMode, validate },
    }).catch(() => {})

    res.json({ ok: true, results, imported: imported.length, failed: results.length - imported.length })
  } catch (err) { fail(res, err, 500) }
})

// ── Путь «загрузкой»: когда бэкенд НЕ на той машине, где лежат аккаунты ────────
// Нужен для удалённого сервера: там читать с диска нечего, файлы приходят по HTTP.

/** Куда складываем залитое. Живёт до конца импорта, потом удаляется. */
const UPLOAD_ROOT = path.join(os.tmpdir(), 'ai-incubator-import')
/** Залитая пачка старше этого срока считается брошенной и подметается. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 4000 }, // tdata — это сотни мелких файлов
})

/** Обезвредить относительный путь из браузера: никаких `..` и абсолютных корней. */
function safeRelative(rel) {
  const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = norm.split('/').filter((p) => p && p !== '.' && p !== '..')
  return parts.join(path.sep)
}

/** Удалить брошенные пачки — иначе temp растёт молча. */
async function sweepUploads() {
  try {
    const entries = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true })
    const now = Date.now()
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(UPLOAD_ROOT, e.name)
      const st = await fs.stat(full).catch(() => null)
      if (st && now - st.mtimeMs > UPLOAD_TTL_MS) await fs.rm(full, { recursive: true, force: true })
    }
  } catch { /* каталога ещё нет — подметать нечего */ }
}

/**
 * Принять папку с аккаунтами через браузер и сразу просканировать.
 * Фронт шлёт файлы полем `files`, а их относительные пути — полем `paths`
 * (в том же порядке): из них восстанавливаем дерево во временной папке.
 */
importRouter.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ ok: false, error: 'Файлы не пришли' })
    const rels = Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.paths].filter(Boolean)

    await sweepUploads()
    const token = `up_${crypto.randomUUID().slice(0, 8)}`
    const root = path.join(UPLOAD_ROOT, token)

    for (let i = 0; i < files.length; i++) {
      const rel = safeRelative(rels[i] || files[i].originalname)
      if (!rel) continue
      const dest = path.join(root, rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, files[i].buffer)
    }

    const { items, scannedDirs } = await scanFolder(root, { passcode: req.body?.passcode })
    const keys = await existingAccountKeys()
    const marked = items.map((it) => ({ ...it, known: isKnownByPhone(keys, it.phone) }))
    res.json({
      ok: true,
      token,
      root,
      items: marked,
      scannedDirs,
      tdata: marked.filter((i) => i.kind === 'tdata').length,
      files: marked.filter((i) => i.kind === 'session-file').length,
    })
  } catch (err) { fail(res, err, 500) }
})

/** Убрать залитую пачку, когда импорт закончен (или человек передумал). */
importRouter.post('/upload/:token/cleanup', async (req, res) => {
  try {
    const token = String(req.params.token || '')
    if (!/^up_[a-z0-9]+$/i.test(token)) return res.status(400).json({ ok: false, error: 'Некорректный токен' })
    await fs.rm(path.join(UPLOAD_ROOT, token), { recursive: true, force: true })
    res.json({ ok: true })
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

/**
 * Предложить раскладку «аккаунт ↔ прокси» перед импортом.
 *
 * Считает сервер, а не форма: правило раскладки одно на систему и уже покрыто тестами.
 * Форма только показывает результат и даёт его поправить — иначе появилась бы вторая,
 * ни на что не похожая реализация внутри UI.
 */
importRouter.post('/pair-preview', async (req, res) => {
  try {
    const { accounts = [], proxyUrls = null, matchGeo = false, skipDead = true } = req.body ?? {}
    if (!Array.isArray(accounts) || !accounts.length) {
      return res.status(400).json({ ok: false, error: 'Нет аккаунтов' })
    }
    const all = await listProxies()
    const meta = await loadAllMeta()
    const busy = new Set(Object.values(meta || {}).map((m) => m?.proxy).filter((u) => u && u !== '—'))

    // Если форма прислала свой список (например, только что добавленные) — берём его
    // в присланном порядке. Иначе — все свободные из пула.
    const byUrl = new Map(all.map((p) => [toProxyUrl(p), p]))
    const pool = Array.isArray(proxyUrls) && proxyUrls.length
      ? proxyUrls.map((u) => ({ url: u, country: byUrl.get(u)?.country || '', status: byUrl.get(u)?.status || 'unknown' }))
      : all.filter((p) => !busy.has(toProxyUrl(p)))
        .map((p) => ({ url: toProxyUrl(p), country: p.country || '', status: p.status }))

    // Страна аккаунта выводится из номера — справочник кодов живёт на сервере,
    // держать его вторую копию в форме незачем.
    const withCountry = accounts.map((a) => ({
      ...a,
      country: a?.country || (a?.phone ? countryFromPhone(a.phone) : '') || '',
    }))
    const pairs = pairByOrder(withCountry, pool, { matchGeo, skipDead })
    res.json({
      ok: true,
      pairs,
      pool,
      shortage: Math.max(0, accounts.length - pairs.filter(Boolean).length),
    })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Массовая привязка прокси к УЖЕ ЗАЛИТЫМ аккаунтам.
 *
 * Раздача прокси была только в импорте: залил пачку — получил по прокси на каждого.
 * А дальше тупик: прокси сдох, купили новый пул, аккаунты переехали — и всё это
 * руками, по одному через карточку. Логику раздачи не дублируем, берём ту же
 * `distributeProxies`, чтобы правило «1 прокси = 1 аккаунт» жило в одном месте.
 *
 * Занятыми считаем прокси ЧУЖИХ аккаунтов: те, что висят на выбранных, освобождаются —
 * иначе перепривязка той же пачки на тот же пул сразу упиралась бы в «не хватило».
 */
importRouter.post('/assign-proxies', async (req, res) => {
  try {
    const { accountIds = [], mode = 'pool', proxyIds = [], singleProxy = '' } = req.body ?? {}
    const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : []
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Выберите аккаунты' })
    if (mode === 'single' && !singleProxy) return res.status(400).json({ ok: false, error: 'Выберите прокси' })

    const all = await listProxies()
    const chosen = proxyIds.length ? all.filter((p) => proxyIds.includes(p.id)) : all.filter((p) => p.status !== 'dead')
    const meta = await loadAllMeta()
    const mine = new Set(ids)
    const busy = new Set(
      Object.entries(meta || {})
        .filter(([id]) => !mine.has(id))
        .map(([, m]) => m?.proxy)
        .filter((u) => u && u !== '—'),
    )
    const assigned = distributeProxies(ids.map((id) => ({ id })), {
      mode, proxyUrls: chosen.map(toProxyUrl), single: singleProxy, busy,
    })

    const rows = []
    for (let i = 0; i < ids.length; i++) {
      const proxy = assigned[i]
      if (mode === 'pool' && !proxy) {
        rows.push({ accountId: ids[i], ok: false, reason: 'не хватило свободных прокси в пуле' })
        continue
      }
      // «Без прокси» — это прочерк, а не пустая строка: так прямое подключение
      // отображается в списке и не путается с «прокси ещё не назначали».
      await setAccountMeta(ids[i], { proxy: mode === 'none' ? '—' : proxy })
      rows.push({ accountId: ids[i], ok: true, proxy: mode === 'none' ? null : proxy })
    }

    const okCount = rows.filter((r) => r.ok).length
    await appendAudit({
      action: 'account.proxy.assign',
      module: 'accounts',
      initiator: req.header('x-user-id') || 'operator',
      reason: mode === 'none'
        ? `Прокси сняты с ${okCount} акк.`
        : `Прокси назначены ${okCount} акк. (${mode === 'single' ? 'один на всех' : 'по одному из пула'})`,
      scope: { accounts: ids },
    }).catch(() => {})

    res.json({ ok: true, applied: okCount, rows })
  } catch (err) { fail(res, err, 500) }
})

export default importRouter
