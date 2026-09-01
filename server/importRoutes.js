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
import { listProxies, toProxyUrl, proxyUsageMap, isUsableProxy } from './proxies.js'
import { proxyPatch, findByUrl } from './lib/proxyLink.js'
import { loadAllMeta, setAccountMeta, countryFromPhone } from './accountsMeta.js'
import { appendAudit } from './lib/auditLog.js'
import { authEnforced } from './lib/session.js'

export const importRouter = Router()

/**
 * Разрешён ли импорт «с диска сервера» (проводник по папкам, скан по пути).
 *
 * ⚠️ Критично: browse/scan читают ФС той машины, где крутится бэкенд. Локально это ПК
 * оператора — норм. На хостинге (`SESSION_SECRET` задан) любой вошедший клиент через
 * этот роут гулял бы по диску сервера — это утечка/обход доступа. Поэтому на проде
 * путь «с диска» выключен: остаётся только загрузка папки с ПК пользователя.
 * Явный `IMPORT_LOCAL_FS=1` может вернуть его (напр. одиночный self-hosted).
 */
function localFsAllowed() {
  return !authEnforced() || process.env.IMPORT_LOCAL_FS === '1'
}

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/** Что умеет импорт в текущем окружении — чтобы форма не показывала недоступное. */
importRouter.get('/capabilities', (_req, res) => {
  res.json({ ok: true, localFs: localFsAllowed() })
})

/** Проводник по папкам сервера — чтобы не заставлять человека вручную писать путь. */
importRouter.post('/browse', async (req, res) => {
  if (!localFsAllowed()) return fail(res, 'Просмотр диска сервера отключён — загрузите папку с вашего ПК', 403)
  try {
    const dir = String(req.body?.path || '')
    res.json({ ok: true, path: dir, ...(await listDirs(dir)) })
  } catch (err) { fail(res, err) }
})

/** Найти аккаунты в папке. Ничего не импортирует — только показывает, что нашлось. */
importRouter.post('/scan', async (req, res) => {
  if (!localFsAllowed()) return fail(res, 'Импорт с диска сервера отключён — загрузите папку с вашего ПК', 403)
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
    // Импортируем В ПРОСТРАНСТВО: аккаунт достаётся владельцу, даже если файлы залил суб.
    const me = req.header('x-user-id')
    const { resolveSubscriptionOwner, getUser } = await import('./users.js')
    // Импорт — тоже пополнение парка: сотруднику нельзя (правка 27.08), см. /api/tg/send-code.
    if (me) {
      const u = await getUser(me).catch(() => null)
      if (u?.parentId) return res.status(403).json({ ok: false, error: 'Аккаунты заводит владелец пространства — попросите выдать вам доступ' })
    }
    let ownerId = me ? await resolveSubscriptionOwner(me) : ''
    /*
     * Импорт «для платформы» (правка 27.08): аккаунт заводится не клиенту, а нам — под
     * ревизию общей базы в админ-панели. Владельца не получает и в клиентских списках не
     * появляется. Разрешено ТОЛЬКО администратору: иначе любой клиент мог бы вывести свои
     * аккаунты из-под учёта пространства.
     */
    const { isAdminRequest } = await import('./lib/accessGuard.js')
    const forPlatform = req.body?.forPlatform === true && await isAdminRequest(req)
    if (forPlatform) ownerId = ''
    const { proxyMode = 'pool', proxyIds = [], singleProxy = '', manualProxies = [], validate = true, passcode = '', root = '' } = req.body ?? {}

    // На проде импорт с диска сервера запрещён (см. localFsAllowed): единственный
    // легальный источник — залитая папка во временном каталоге. Всё остальное — отказ.
    if (!localFsAllowed()) {
      const up = path.resolve(UPLOAD_ROOT)
      const base = root ? path.resolve(String(root)) : ''
      if (!base || (base !== up && !base.startsWith(up + path.sep))) {
        return res.status(403).json({ ok: false, error: 'Импорт с диска сервера отключён — загрузите папку с вашего ПК' })
      }
    }

    // Пути приходят от клиента, поэтому импортировать разрешаем только из той папки,
    // которую перед этим сканировали (или куда залили файлы). Иначе через этот роут
    // можно было бы ткнуть в произвольный файл на сервере.
    if (root) {
      const base = path.resolve(String(root))
      const inside = (p) => { const r = path.resolve(String(p || '')); return r === base || r.startsWith(base + path.sep) }
      // Проверяем И основной путь, И запасной .session (altSession) — иначе через
      // altSession можно было бы подсунуть произвольный файл с диска сервера.
      const outside = items.find((it) => !inside(it?.path) || (it?.altSession && !inside(it.altSession)))
      if (outside) return res.status(400).json({ ok: false, error: 'Путь вне просканированной папки' })
    }

    // Пул прокси: берём выбранные (или все живые). Дубли разрешены — «занятые» больше
    // не исключаем: один прокси можно повесить на несколько аккаунтов.
    const all = await listProxies()
    const chosen = proxyIds.length ? all.filter((p) => proxyIds.includes(p.id)) : all.filter(isUsableProxy)
    const assigned = distributeProxies(items, {
      mode: proxyMode,
      proxyUrls: chosen.map(toProxyUrl),
      single: singleProxy,
      // `manual` — раскладка из таблицы «аккаунт ↔ прокси»: оператор её уже видел
      // и поправил, переставлять нельзя.
      manual: manualProxies,
    })

    const results = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      // Нет прокси (пул пуст) — НЕ отбраковываем аккаунт: заводим через прямой IP.
      // Дубли прокси разрешены, «нехватки» больше нет; риск без прокси показан в UI.
      const proxy = assigned[i]
      try {
        const r = await importOne(it, { proxy, validate, passcode, ownerId })
        // Отмечаем наш аккаунт сразу: дежурным по ревизии его назначат в админ-панели.
        if (forPlatform && r?.ok && r.accountId) await setAccountMeta(r.accountId, { platform: true })
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

/**
 * Подсказка для UI по прокси. Дубли разрешены, поэтому «свободно» — это прокси, на
 * которых пока НОЛЬ аккаунтов (просто информативно), а не лимит. `usable` — сколько
 * вообще можно раздавать (все не-мёртвые, каждый — на сколько угодно аккаунтов).
 */
importRouter.get('/proxy-capacity', async (_req, res) => {
  try {
    const all = await listProxies()
    const meta = await loadAllMeta()
    const usage = proxyUsageMap(meta)
    const usable = all.filter(isUsableProxy)
    const unused = usable.filter((p) => !(usage[toProxyUrl(p)]?.length))
    // `free` оставляем для обратной совместимости фронта = сколько ещё не занятых.
    res.json({ ok: true, total: all.length, usable: usable.length, free: unused.length, freeIds: unused.map((p) => p.id) })
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
    const usage = proxyUsageMap(meta) // url → [accountId], для счётчика «занят N»

    // Если форма прислала свой список (например, только что добавленные) — берём его
    // в присланном порядке. Иначе — ВЕСЬ пул: дубли разрешены, занятые не прячем,
    // а показываем со счётчиком использования.
    const byUrl = new Map(all.map((p) => [toProxyUrl(p), p]))
    const usedCount = (u) => (usage[u]?.length || 0)
    const pool = Array.isArray(proxyUrls) && proxyUrls.length
      ? proxyUrls.map((u) => ({ url: u, country: byUrl.get(u)?.country || '', status: byUrl.get(u)?.status || 'unknown', used: usedCount(u) }))
      : all.map((p) => ({ url: toProxyUrl(p), country: p.country || '', status: p.status, used: usedCount(toProxyUrl(p)) }))

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
 * `distributeProxies` — она раздаёт по кругу с разрешёнными дублями.
 */
importRouter.post('/assign-proxies', async (req, res) => {
  try {
    const { accountIds = [], mode = 'pool', proxyIds = [], singleProxy = '' } = req.body ?? {}
    const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : []
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Выберите аккаунты' })
    if (mode === 'single' && !singleProxy) return res.status(400).json({ ok: false, error: 'Выберите прокси' })

    const all = await listProxies()
    const chosen = proxyIds.length ? all.filter((p) => proxyIds.includes(p.id)) : all.filter(isUsableProxy)
    // Дубли разрешены — «занятые» не исключаем: один прокси можно повесить на многих.
    const assigned = distributeProxies(ids.map((id) => ({ id })), {
      mode, proxyUrls: chosen.map(toProxyUrl), single: singleProxy,
    })

    const rows = []
    for (let i = 0; i < ids.length; i++) {
      const proxy = assigned[i]
      if (mode === 'pool' && !proxy) {
        rows.push({ accountId: ids[i], ok: false, reason: 'нет ни одного прокси в пуле' })
        continue
      }
      /*
       * MR-262: пишем КЛЮЧ каталога, а не только строку.
       *
       * Строку оставляем рядом — её читают воркеры и витрина, — но источником истины
       * становится `proxyId`: смена пароля в каталоге теперь доходит до всех аккаунтов
       * сама, а не остаётся в сорока копиях.
       */
      const запись = mode === 'none' ? null : findByUrl(all, proxy)
      await setAccountMeta(ids[i], mode === 'none'
        // «Без прокси» — это прочерк, а не пустая строка: так прямое подключение
        // отображается в списке и не путается с «прокси ещё не назначали».
        ? { proxyId: '', proxy: '—' }
        : { ...proxyPatch(запись), ...(запись ? {} : { proxy }) })
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
