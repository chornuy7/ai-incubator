// Хранилище сессии TGStat (cookies) и импортов (задач парсинга) + фоновый воркер.
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseTgstatChats, cookieHeaderFromState, hasTelegramLogin, cookieSummary, ParseError } from './parser.js'
import { REGION_HOSTS, DEFAULT_HOST, buildCatalogUrl } from './constants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', 'data', 'tgstat')
const IMPORTS_DIR = path.join(ROOT, 'imports')
const SESSION_FILE = path.join(ROOT, 'session.json')

async function ensureDirs() { await fs.mkdir(IMPORTS_DIR, { recursive: true }) }
const nowIso = () => new Date().toISOString()

// ── session ──

const EMPTY_SESSION = {
  status: 'none', has_session: false, telegram_logged_in: false,
  cookie_count: 0, last_verified_at: null, error_msg: null,
}

export async function loadSessionRaw() {
  try { return JSON.parse(await fs.readFile(SESSION_FILE, 'utf8')) } catch { return null }
}

/** DTO без самих cookies (наружу секреты не отдаём). */
export async function getSessionDto() {
  const s = await loadSessionRaw()
  if (!s || !s.cookies?.length) return { ...EMPTY_SESSION }
  return {
    status: s.status || 'active',
    has_session: true,
    telegram_logged_in: !!s.telegram_logged_in,
    cookie_count: s.cookies.length,
    last_verified_at: s.last_verified_at || null,
    error_msg: s.error_msg || null,
    cookie_summary: cookieSummary(s),
  }
}

/** Сохранить cookies (Cookie-Editor JSON: {cookies:[...]}). */
export async function saveSession(state) {
  await ensureDirs()
  const cookies = Array.isArray(state?.cookies) ? state.cookies : (Array.isArray(state) ? state : [])
  const tgCookies = cookies.filter((c) => (c.domain || '').toLowerCase().includes('tgstat'))
  if (!tgCookies.length) throw new Error('В файле нет cookies TGStat. Экспортируйте их Cookie-Editor на uk.tgstat.com.')
  const rec = {
    cookies,
    status: 'active',
    telegram_logged_in: hasTelegramLogin({ cookies }),
    last_verified_at: null,
    error_msg: null,
    updatedAt: nowIso(),
  }
  await fs.writeFile(SESSION_FILE, JSON.stringify(rec, null, 2), 'utf8')
  return getSessionDto()
}

export async function clearSession() {
  try { await fs.unlink(SESSION_FILE) } catch { /* нет файла */ }
  return { ...EMPTY_SESSION }
}

/** Проверка: пробуем открыть каталог crypto на зеркале региона. */
export async function verifySession(region) {
  const s = await loadSessionRaw()
  if (!s || !s.cookies?.length) return { ok: false, message: 'Сессия не загружена — сначала загрузите cookies.', status: 'none' }
  const host = REGION_HOSTS[region || 'russia'] || DEFAULT_HOST
  const url = buildCatalogUrl(host, 'crypto')
  try {
    const { DEFAULT_HEADERS } = await import('./constants.js')
    const headers = { ...DEFAULT_HEADERS, Cookie: cookieHeaderFromState(s) }
    const resp = await fetch(url, { headers, redirect: 'follow' })
    const html = await resp.text()
    const low = html.toLowerCase()
    const ok = resp.status === 200 && (low.includes('peer-item') || low.includes('/channel/'))
    s.status = ok ? 'active' : 'error'
    s.last_verified_at = ok ? nowIso() : s.last_verified_at
    s.error_msg = ok ? null : `TGStat вернул HTTP ${resp.status} / каталог не распознан. Проверьте регион и свежесть cookies.`
    await fs.writeFile(SESSION_FILE, JSON.stringify(s, null, 2), 'utf8')
    return {
      ok,
      message: ok
        ? `Сессия работает ✓ (${host}). Вход через Telegram: ${s.telegram_logged_in ? 'есть' : 'нет — лимит ~100'}.`
        : s.error_msg,
      status: s.status,
    }
  } catch (e) {
    s.status = 'error'; s.error_msg = String(e?.message || e)
    await fs.writeFile(SESSION_FILE, JSON.stringify(s, null, 2), 'utf8')
    return { ok: false, message: `Ошибка проверки: ${s.error_msg}`, status: 'error' }
  }
}

// ── imports ──

function importPath(id) { return path.join(IMPORTS_DIR, `${id}.json`) }

async function nextImportId() {
  await ensureDirs()
  const files = await fs.readdir(IMPORTS_DIR)
  const ids = files.filter((f) => f.endsWith('.json')).map((f) => Number(f.replace('.json', ''))).filter(Number.isFinite)
  return (ids.length ? Math.max(...ids) : 0) + 1
}

function importDto(imp) {
  const { chats, ...rest } = imp
  return rest
}

export async function createImport({ category, region, max_pages, min_subscribers }) {
  await ensureDirs()
  const id = await nextImportId()
  const imp = {
    id,
    category,
    region: region || null,
    max_pages: Math.max(1, Math.min(100, Number(max_pages) || 1)),
    min_subscribers: Math.max(0, Number(min_subscribers) || 0),
    status: 'queued',
    total_found: 0,
    pages_processed: 0,
    error_msg: null,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    cancelRequested: false,
    chats: [],
  }
  await fs.writeFile(importPath(id), JSON.stringify(imp, null, 2), 'utf8')
  runImport(id) // fire-and-forget
  return importDto(imp)
}

export async function loadImport(id) {
  try { return JSON.parse(await fs.readFile(importPath(id), 'utf8')) } catch { return null }
}

async function saveImport(imp) {
  await fs.writeFile(importPath(imp.id), JSON.stringify(imp, null, 2), 'utf8')
}

export async function listImports() {
  await ensureDirs()
  const files = await fs.readdir(IMPORTS_DIR)
  const out = []
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try { out.push(importDto(JSON.parse(await fs.readFile(path.join(IMPORTS_DIR, f), 'utf8')))) } catch { /* skip */ }
  }
  out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  return out.slice(0, 100)
}

export async function getImportDto(id) {
  const imp = await loadImport(id)
  return imp ? importDto(imp) : null
}

export async function getChats(id, minSubscribers = 0, limit = 10000) {
  const imp = await loadImport(id)
  if (!imp) return null
  let chats = imp.chats || []
  if (minSubscribers) chats = chats.filter((c) => c.subscribers >= minSubscribers)
  return chats.slice(0, limit)
}

export async function cancelImport(id) {
  const imp = await loadImport(id)
  if (!imp) return null
  if (imp.status === 'queued' || imp.status === 'running') {
    imp.cancelRequested = true
    if (imp.status === 'queued') { imp.status = 'cancelled'; imp.finished_at = nowIso() }
    await saveImport(imp)
  }
  return importDto(imp)
}

export async function deleteImport(id) {
  try { await fs.unlink(importPath(id)) } catch { /* нет файла */ }
  return true
}

// ── worker ──

const runningImports = new Set()

export async function runImport(id) {
  if (runningImports.has(id)) return
  runningImports.add(id)
  let imp = await loadImport(id)
  if (!imp) { runningImports.delete(id); return }

  const state = await loadSessionRaw()
  imp.status = 'running'
  imp.started_at = nowIso()
  await saveImport(imp)

  const seen = new Set()
  try {
    if (!state?.cookies?.length) throw new ParseError('Сессия TGStat не подключена. Загрузите cookies.')
    const cancelCheck = () => imp?.cancelRequested === true

    for await (const { page, chat } of parseTgstatChats(imp.category, imp.region, imp.max_pages, imp.min_subscribers, state, cancelCheck)) {
      if (cancelCheck()) break
      if (seen.has(chat.chat_link)) continue
      seen.add(chat.chat_link)
      imp.chats.push({ id: imp.chats.length + 1, import_id: id, ...chat, created_at: nowIso() })
      imp.total_found = imp.chats.length
      imp.pages_processed = Math.max(imp.pages_processed, page)
      // периодически сбрасываем прогресс на диск
      if (imp.chats.length % 20 === 0) await saveImport(imp)
      // подхватываем cancel из свежей версии
      const fresh = await loadImport(id)
      if (fresh?.cancelRequested) { imp.cancelRequested = true; break }
    }
    imp.status = imp.cancelRequested ? 'cancelled' : 'completed'
    if (imp.total_found === 0 && imp.status === 'completed') {
      imp.error_msg = 'Каналы не найдены. Проверьте категорию/регион и свежесть cookies TGStat.'
    }
  } catch (e) {
    imp.status = imp.total_found > 0 ? 'completed' : 'failed'
    imp.error_msg = (imp.total_found > 0 ? 'Частично: ' : '') + String(e?.message || e)
  }
  imp.finished_at = nowIso()
  await saveImport(imp)
  runningImports.delete(id)
}
