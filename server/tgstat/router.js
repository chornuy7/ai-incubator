// REST-роутер парсера TGStat: /api/tgstat/*
import express from 'express'
import { catalogOptions } from './constants.js'
import {
  getSessionDto, saveSession, clearSession, verifySession, loadSessionRaw,
  createImport, listImports, getImportDto, getChats, cancelImport, deleteImport, loadImport,
} from './store.js'
import { parseTgstatChats, searchTgstatChannels } from './parser.js'

export const tgstatRouter = express.Router()

const ok = (res, data) => res.json({ ok: true, ...data })
const fail = (res, code, error) => res.status(code).json({ ok: false, error })

// ── options ──
tgstatRouter.get('/options', (_req, res) => ok(res, { options: catalogOptions() }))

// ── целевые каналы/группы из каталога TGStat (синхронно, для «Взять цели из TGStat») ──
tgstatRouter.post('/targets', async (req, res) => {
  const { category, region, maxPages, minSubscribers, limit } = req.body || {}
  if (!category) return fail(res, 400, 'Выберите категорию')
  const session = await getSessionDto()
  if (!session.has_session) return fail(res, 400, 'Сначала подключите TGStat (загрузите cookies).')
  try {
    const state = await loadSessionRaw()
    const cap = Math.min(Number(limit) || 200, 1000)
    const out = []
    const seen = new Set()
    for await (const { chat } of parseTgstatChats(category, region || null, Math.max(1, Math.min(20, Number(maxPages) || 1)), Number(minSubscribers) || 0, state, () => out.length >= cap)) {
      if (out.length >= cap) break
      const u = chat.chat_username
      if (!u || seen.has(u)) continue
      seen.add(u)
      out.push({ username: u, title: chat.chat_name, subscribers: chat.subscribers, link: chat.chat_link })
    }
    ok(res, { targets: out })
  } catch (e) {
    fail(res, 400, e?.message || 'Не удалось получить цели из TGStat')
  }
})

// ── расширенный поиск каналов с фильтрами (охват/ER/ИЦ/аудитория и т.д.) ──
tgstatRouter.post('/search', async (req, res) => {
  try {
    const { filters, maxPages } = req.body || {}
    const session = await getSessionDto()
    if (!session.has_session) return fail(res, 400, 'Сначала подключите TGStat (загрузите cookies).')
    const state = await loadSessionRaw()
    const chats = await searchTgstatChannels(filters || {}, state, Math.max(1, Math.min(20, Number(maxPages) || 3)))
    ok(res, { chats })
  } catch (e) {
    fail(res, 400, e?.message || 'Ошибка поиска TGStat')
  }
})

// ── session ──
tgstatRouter.get('/session', async (_req, res) => {
  ok(res, { session: await getSessionDto() })
})

tgstatRouter.post('/session/upload', async (req, res) => {
  try {
    const payload = req.body?.storage_state ?? req.body?.cookies ?? req.body
    const state = Array.isArray(payload) ? { cookies: payload }
      : (Array.isArray(payload?.cookies) ? { cookies: payload.cookies } : payload)
    const session = await saveSession(state)
    ok(res, { session })
  } catch (e) {
    fail(res, 400, e?.message || 'Не удалось сохранить cookies')
  }
})

tgstatRouter.post('/session/verify', async (req, res) => {
  const region = req.query.region || req.body?.region
  ok(res, { result: await verifySession(region) })
})

tgstatRouter.delete('/session', async (_req, res) => {
  ok(res, { session: await clearSession() })
})

// ── imports ──
tgstatRouter.get('/imports', async (_req, res) => ok(res, { imports: await listImports() }))

tgstatRouter.post('/imports', async (req, res) => {
  try {
    const { category, region, max_pages, min_subscribers } = req.body || {}
    if (!category) return fail(res, 400, 'Выберите категорию')
    const session = await getSessionDto()
    if (!session.has_session) return fail(res, 400, 'Сначала подключите TGStat (загрузите cookies).')
    const imp = await createImport({ category, region, max_pages, min_subscribers })
    res.status(201).json({ ok: true, import: imp })
  } catch (e) {
    fail(res, 400, e?.message || 'Не удалось создать импорт')
  }
})

tgstatRouter.get('/imports/:id', async (req, res) => {
  const imp = await getImportDto(Number(req.params.id))
  if (!imp) return fail(res, 404, 'Импорт не найден')
  ok(res, { import: imp })
})

tgstatRouter.get('/imports/:id/chats', async (req, res) => {
  const chats = await getChats(Number(req.params.id), Number(req.query.min_subscribers) || 0, Number(req.query.limit) || 10000)
  if (chats === null) return fail(res, 404, 'Импорт не найден')
  ok(res, { chats })
})

tgstatRouter.post('/imports/:id/cancel', async (req, res) => {
  const imp = await cancelImport(Number(req.params.id))
  if (!imp) return fail(res, 404, 'Импорт не найден')
  ok(res, { import: imp })
})

tgstatRouter.delete('/imports/:id', async (req, res) => {
  await deleteImport(Number(req.params.id))
  ok(res, {})
})

tgstatRouter.get('/imports/:id/export.csv', async (req, res) => {
  const imp = await loadImport(Number(req.params.id))
  if (!imp) return fail(res, 404, 'Импорт не найден')
  const header = 'chat_name,subscribers,region,category,category_code,chat_link,source_tgstat_url\n'
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = (imp.chats || []).map((c) =>
    [c.chat_name, c.subscribers, c.region, c.category, c.category_code, c.chat_link, c.source_tgstat_url].map(esc).join(',')).join('\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="tgstat-import-${imp.id}.csv"`)
  res.send('﻿' + header + rows)
})
