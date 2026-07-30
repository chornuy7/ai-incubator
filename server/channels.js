/**
 * Сущность «Канал» (§3.7/§3.8/§3.9). Общая база каналов: повторный парсинг обновляет карточку
 * и связи, а не создаёт дубль (§4 «данные канала не теряются»). Дедуп по username/peerId.
 * Хранение — JSON data/channels.json; путь через env CHANNELS_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const CHANNELS_FILE = process.env.CHANNELS_FILE || dataPath('channels.json')

// §10.2: каналы переехали в Supabase (таблица `channels`). Стор исторически работает
// со ВСЕМ списком (read-modify-write), и переписывать его логику на точечные запросы
// значило бы трогать дедуп и слияние карточек — самую тонкую часть парсера. Поэтому
// здесь адаптер: те же «прочитать список / записать список», но поверх БД.
// Записей десятки-сотни, и пишет их пакетный парсер, а не горячий путь.
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sbCh() { return supabaseEnabled() ? getSupabase() : null }

/** Строка БД → объект канала (ключевые поля колонками, остальное в data). */
const rowToChannel = (r) => ({
  ...(r.data || {}),
  id: r.id,
  userId: r.user_id || undefined,
  title: r.title || '',
  username: r.username || '',
  link: r.link || '',
  subscribers: Number(r.subscribers) || 0,
  hasComments: r.has_comments ?? null,
  tgPeerId: r.tg_peer_id || null,
  rating: r.rating ?? null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
})

/** Объект канала → строка БД. */
const channelToRow = (c) => {
  const { id, title, username, link, subscribers, hasComments, tgPeerId, rating, userId, createdAt, updatedAt, ...rest } = c
  return {
    id,
    user_id: userId || null,
    title: title || '',
    username: username || '',
    link: link || '',
    subscribers: Number(subscribers) || 0,
    has_comments: hasComments ?? false,
    tg_peer_id: tgPeerId || '',
    rating: rating ?? null,
    data: rest,
    created_at: new Date(createdAt || Date.now()).toISOString(),
    updated_at: new Date(updatedAt || Date.now()).toISOString(),
  }
}

/** Прочитать весь список — из БД либо из файла. */
async function readAll() {
  const db = sbCh()
  if (db) {
    const { data, error } = await db.from('channels').select('*').order('updated_at', { ascending: false })
    // Таблицы ещё нет (миграция не применена) — работаем по файлу, не роняя парсер.
    if (error) return readJson(CHANNELS_FILE, [])
    return (data || []).map(rowToChannel)
  }
  return readJson(CHANNELS_FILE, [])
}

/** Записать весь список: upsert всех + удаление тех, кого в списке больше нет. */
async function writeAll(all) {
  const db = sbCh()
  if (!db) return writeJson(CHANNELS_FILE, all)
  const rows = (all || []).map(channelToRow)
  if (rows.length) {
    const { error } = await db.from('channels').upsert(rows, { onConflict: 'id' })
    if (error) { console.warn('[channels] запись в БД не удалась:', error.message); return writeJson(CHANNELS_FILE, all) }
  }
  // Удалённые каналы: чего нет в списке — нет и в таблице.
  const { data: existing } = await db.from('channels').select('id')
  const keep = new Set(rows.map((r) => r.id))
  const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(id))
  if (gone.length) await db.from('channels').delete().in('id', gone)
  return all
}


/** Нормализовать ключ дедупа: username в нижнем регистре без @, либо peerId. */
export function channelKey(input = {}) {
  const u = String(input.username || '').replace(/^@/, '').toLowerCase()
  if (u) return `u:${u}`
  if (input.tgPeerId) return `p:${input.tgPeerId}`
  const link = String(input.link || '').toLowerCase().replace(/\/+$/, '')
  return link ? `l:${link}` : null
}

export async function listChannels() {
  return readAll()
}

export async function getChannel(id) {
  return (await listChannels()).find((c) => c.id === id) || null
}

/**
 * Upsert канала: если есть по ключу — обновляем поля и добавляем источник, иначе создаём.
 * @param {object} input @param {string} [source] метка источника (запуск парсинга/категория)
 */
export async function upsertChannel(input = {}, source) {
  const key = channelKey(input)
  const all = await listChannels()
  const idx = key ? all.findIndex((c) => channelKey(c) === key) : -1
  const now = Date.now()

  const fields = {
    title: input.title ?? '',
    link: input.link ?? (input.username ? `https://t.me/${String(input.username).replace(/^@/, '')}` : ''),
    username: input.username ? String(input.username).replace(/^@/, '') : '',
    category: input.category ?? '',
    language: input.language ?? '',
    region: input.region ?? '',
    subscribers: Number(input.subscribers) || 0,
    activity: input.activity ?? null,
    hasComments: input.hasComments ?? null,
    rating: input.rating ?? null,
    tgPeerId: input.tgPeerId ?? null,
    botInGroup: input.botInGroup, // true → авто ~раз в час, иначе раз в день (решение 14.07)
  }

  if (idx >= 0) {
    const cur = all[idx]
    const sources = new Set(cur.sources || [])
    if (source) sources.add(source)
    const merged = { ...cur }
    // Обновляем поле только если новое значение осмысленное — непустое старое не затираем.
    for (const [k, v] of Object.entries(fields)) {
      const meaningful = v !== undefined && v !== '' && v !== null && !(typeof v === 'number' && v === 0)
      if (meaningful) merged[k] = v
    }
    merged.sources = [...sources]
    merged.updatedAt = now
    all[idx] = merged
    await writeAll(all)
    return merged
  }

  const channel = {
    id: `ch_${crypto.randomUUID().slice(0, 8)}`,
    ...fields,
    botInGroup: input.botInGroup ?? false,
    sources: source ? [source] : [],
    categoriesExtra: [],
    lastStatsAt: null,
    statsBy: null,
    createdAt: now,
    updatedAt: now,
  }
  all.unshift(channel)
  await writeAll(all)
  return channel
}

/**
 * Пакетный upsert (для парсера): один read-modify-write на весь список.
 * Дедуп по ключу, обновляет карточку + источник, не создаёт дубли (§3.8/§4).
 * @param {object[]} items @param {string} [source]
 */
export async function upsertMany(items = [], source) {
  if (!items.length) return 0
  const all = await listChannels()
  const byKey = new Map()
  all.forEach((c, i) => { const k = channelKey(c); if (k) byKey.set(k, i) })
  const now = Date.now()
  let n = 0
  for (const input of items) {
    const key = channelKey(input)
    if (!key) continue
    const fields = {
      title: input.title ?? '',
      username: input.username ? String(input.username).replace(/^@/, '') : '',
      link: input.link ?? (input.username ? `https://t.me/${String(input.username).replace(/^@/, '')}` : ''),
      subscribers: Number(input.subscribers) || 0,
      hasComments: input.hasComments ?? null,
      tgPeerId: input.tgPeerId ?? null,
    }
    if (byKey.has(key)) {
      const c = all[byKey.get(key)]
      for (const [k, v] of Object.entries(fields)) {
        const ok = v !== undefined && v !== '' && v !== null && !(typeof v === 'number' && v === 0)
        if (ok) c[k] = v
      }
      const src = new Set(c.sources || []); if (source) src.add(source); c.sources = [...src]
      c.updatedAt = now
    } else {
      const c = {
        id: `ch_${crypto.randomUUID().slice(0, 8)}`, ...fields, category: '', language: '', region: '',
        activity: null, rating: null, botInGroup: false, sources: source ? [source] : [], categoriesExtra: [],
        lastStatsAt: null, statsBy: null, createdAt: now, updatedAt: now,
      }
      all.unshift(c); byKey.set(key, 0)
    }
    n += 1
  }
  await writeAll(all)
  return n
}

/** Записать свежую статистику канала (кто обновил, когда). @param {string} id @param {object} stats @param {string} [statsBy] */
export async function recordChannelStats(id, stats = {}, statsBy) {
  const all = await listChannels()
  const i = all.findIndex((c) => c.id === id)
  if (i === -1) return null
  if (stats.subscribers != null) all[i].subscribers = Number(stats.subscribers) || 0
  if (stats.activity != null) all[i].activity = stats.activity
  if (stats.hasComments != null) all[i].hasComments = stats.hasComments
  // 2-й проход (§3.9): метка свежести контента (отдельно от числового activity парсера).
  if (stats.activityLabel != null) all[i].activityLabel = stats.activityLabel
  if (stats.lastPostAt != null) all[i].lastPostAt = stats.lastPostAt
  if (stats.er !== undefined) all[i].er = stats.er // §6: вовлечённость (ER)
  if (stats.avgViews != null) all[i].avgViews = stats.avgViews
  all[i].lastStatsAt = Date.now()
  all[i].statsBy = statsBy || 'system'
  all[i].updatedAt = Date.now()
  await writeAll(all)
  return all[i]
}

/** Обновить редактируемые поля канала (напр. botInGroup, category). @param {string} id @param {object} patch */
export async function updateChannel(id, patch = {}) {
  const all = await listChannels()
  const i = all.findIndex((c) => c.id === id)
  if (i === -1) return null
  const EDITABLE = ['botInGroup', 'category', 'language', 'region', 'title', 'hasComments']
  for (const k of EDITABLE) if (patch[k] !== undefined) all[i][k] = patch[k]
  all[i].updatedAt = Date.now()
  await writeAll(all)
  return all[i]
}

export async function deleteChannel(id) {
  const all = await listChannels()
  const next = all.filter((c) => c.id !== id)
  if (next.length === all.length) return false
  await writeAll(next)
  return true
}
